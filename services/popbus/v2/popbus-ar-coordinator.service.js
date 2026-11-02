// TURENTU POPBUS V2 - FASE 3
// Coordinatore A/R: sola lettura, nessuna conferma o modifica DB.
// Il chiamante deve utilizzare una transazione READ ONLY REPEATABLE READ
// per ottenere uno snapshot coerente. NON collegare al router di produzione.

function errore(messaggio, codice = 'AR_COORDINATOR_INVALID') {
  const e = new Error(messaggio);
  e.code = codice;
  e.status = 409;
  return e;
}

function idPositivo(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw errore('ID attivazione non valido');
  return n;
}

// Trova la chiusura transitiva delle attivazioni collegate dai gruppi A/R.
// Non conferma che la corsa sia attivabile: serve solo a ricostruire
// le dipendenze e a controllare la disponibilita' delle accettazioni.
export async function analizzaDipendenzeAR(client, attivazioneId) {
  const radice = idPositivo(attivazioneId);
  const viste = new Set();
  const daVisitare = [radice];
  const gruppi = new Map();
  const attivazioni = new Map();
  const anomalie = [];
  const adesso = new Date();

  while (daVisitare.length) {
    const id = daVisitare.shift();
    if (viste.has(id)) continue;
    viste.add(id);
    if (viste.size > 1000) throw errore('Troppe attivazioni collegate');

    const { rows: aRows } = await client.query(
      `SELECT a.id, a.stato, a.expires_at, a.veicolo_id,
              p.id AS accettazione_id, p.stato AS accettazione_stato,
              p.expires_at AS accettazione_scadenza,
              p.offerta_id, o.stato AS offerta_stato,
              o.expires_at AS offerta_scadenza
       FROM popbus_attivazioni a
       LEFT JOIN popbus_ar_accettazioni p ON p.attivazione_id = a.id
       LEFT JOIN offerte_autisti o ON o.id = p.offerta_id
       WHERE a.id = $1`, [id]
    );
    if (aRows.length !== 1) {
      anomalie.push(`Attivazione ${id} inesistente`);
      continue;
    }
    const a = aRows[0];
    attivazioni.set(id, a);

    const { rows: legami } = await client.query(
      `SELECT r.id AS richiesta_id, r.cliente_id, r.ar_group_id,
              r.ar_tratta, r.ar_vincolata, r.stato AS richiesta_stato,
              r.corsa_id
       FROM popbus_attivazione_richieste ar
       JOIN richieste_pop_bus r ON r.id = ar.richiesta_id
       WHERE ar.attivazione_id = $1 AND ar.attiva
       ORDER BY r.id`, [id]
    );

    for (const r of legami) {
      if (r.ar_vincolata !== true) continue;
      if (!r.ar_group_id) {
        anomalie.push(`Richiesta ${r.richiesta_id} A/R senza gruppo`);
        continue;
      }
      gruppi.set(String(r.ar_group_id), true);
    }

    if (gruppi.size > 1000) throw errore('Troppi gruppi A/R collegati');

    // Ricerca le altre attivazioni di tutti i gruppi incontrati.
    // Una richiesta non assegnata e' rilevata nella verifica finale.
    if (gruppi.size) {
      const { rows: collegate } = await client.query(
        `SELECT DISTINCT ar.attivazione_id
         FROM richieste_pop_bus r
         JOIN popbus_attivazione_richieste ar
           ON ar.richiesta_id = r.id AND ar.attiva
         WHERE r.ar_vincolata = TRUE
           AND r.ar_group_id = ANY($1::uuid[])`,
        [Array.from(gruppi.keys())]
      );
      for (const c of collegate) {
        const next = Number(c.attivazione_id);
        if (!viste.has(next) && !daVisitare.includes(next)) daVisitare.push(next);
      }
    }
  }

  if (gruppi.size === 0) {
    anomalie.push('Nessuna richiesta A/R vincolata nelle attivazioni analizzate');
  }

  const gruppiDettaglio = [];
  for (const gid of gruppi.keys()) {
    const { rows } = await client.query(
      `SELECT g.id AS gruppo_id, g.cliente_id AS gruppo_cliente_id,
              g.stato AS gruppo_stato, g.expires_at AS gruppo_scadenza,
              r.id AS richiesta_id, r.cliente_id AS richiesta_cliente_id,
              r.ar_tratta, r.ar_vincolata, r.stato AS richiesta_stato,
              r.corsa_id, ar.attivazione_id
       FROM ar_gruppi g
       LEFT JOIN richieste_pop_bus r ON r.ar_group_id = g.id
       LEFT JOIN popbus_attivazione_richieste ar
         ON ar.richiesta_id = r.id AND ar.attiva
       WHERE g.id = $1::uuid
       ORDER BY r.id`, [gid]
    );
    if (!rows.length) {
      anomalie.push(`Gruppo ${gid} inesistente`);
      continue;
    }
    const g = rows[0];
    const richieste = rows.filter(x => x.richiesta_id != null);
    const tratte = richieste.map(x => x.ar_tratta);
    if (richieste.length !== 2 ||
        tratte.filter(x => x === 'andata').length !== 1 ||
        tratte.filter(x => x === 'ritorno').length !== 1) {
      anomalie.push(`Gruppo ${gid}: coppia A/R non valida`);
    }
    if (richieste.some(x => x.ar_vincolata !== true ||
        String(x.richiesta_cliente_id) !== String(g.gruppo_cliente_id))) {
      anomalie.push(`Gruppo ${gid}: cliente o vincolo incoerente`);
    }
    if (richieste.some(x => x.richiesta_stato !== 'in_lavorazione' || x.corsa_id != null)) {
      anomalie.push(`Gruppo ${gid}: richieste non convertibili`);
    }
    if (new Date(g.gruppo_scadenza) <= adesso ||
        !['autorizzato', 'in_attesa', 'pronto'].includes(g.gruppo_stato)) {
      anomalie.push(`Gruppo ${gid}: stato o scadenza non validi`);
    }
    if (richieste.some(x => x.attivazione_id == null)) {
      anomalie.push(`Gruppo ${gid}: tratta senza attivazione`);
    }
    gruppiDettaglio.push({
      id: gid,
      stato: g.gruppo_stato,
      richieste: richieste.map(x => ({
        id: x.richiesta_id,
        tratta: x.ar_tratta,
        attivazioneId: x.attivazione_id
      }))
    });
  }

  const mancanti = [];
  for (const a of attivazioni.values()) {
    if (a.stato !== 'in_attesa_autista' ||
        (a.expires_at && new Date(a.expires_at) <= adesso)) {
      anomalie.push(`Attivazione ${a.id}: stato o scadenza non validi`);
    }
    if (!a.accettazione_id) {
      mancanti.push(a.id);
    } else if (a.accettazione_stato !== 'provvisoria' ||
               a.offerta_stato !== 'inviata' ||
               new Date(a.accettazione_scadenza) <= adesso ||
               new Date(a.offerta_scadenza) <= adesso) {
      anomalie.push(`Attivazione ${a.id}: accettazione/offerta non valida`);
    }
  }

  const stato = anomalie.length ? 'non_valida' : mancanti.length ? 'in_attesa' : 'pronta';
  return {
    stato,
    attivazioneRadice: radice,
    attivazioni: Array.from(attivazioni.keys()).sort((a, b) => a - b),
    gruppi: gruppiDettaglio,
    accettazioniMancanti: mancanti.sort((a, b) => a - b),
    anomalie,
    // 'pronta' NON autorizza la conversione: occorre il preflight completo
    // e la conferma atomica nella stessa transazione.
    confermaAbilitata: false
  };
}
