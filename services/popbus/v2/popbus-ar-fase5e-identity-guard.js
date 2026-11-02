// TURENTU POPBUS V2 - FASE 5E: guardia identita' offerte A/R.
// SOLO LETTURA: nessuna conversione, nessuna DML, nessun accesso Stripe.
// Usare esclusivamente dentro una transazione con lock globale gia' acquisito.
// NON collegare al router. Non sostituisce il preflight PIXEL/veicoli/pagamenti.

function fail(message) {
  const e = new Error(message);
  e.code = 'AR_IDENTITY_INVALID';
  e.status = 409;
  return e;
}
function positive(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw fail('Identificativo non valido');
  return n;
}

export async function verificaIdentitaOfferteAR(client, analisi) {
  if (!client || typeof client.query !== 'function' ||
      analisi?.stato !== 'pronta' || !Array.isArray(analisi.attivazioni) ||
      !Array.isArray(analisi.gruppi) || !analisi.gruppi.length ||
      analisi.anomalie?.length || analisi.confermaAbilitata !== false) {
    throw fail('Analisi A/R non pronta o non valida');
  }
  const ids = analisi.attivazioni.map(positive).sort((a, b) => a - b);
  if (ids.length < 1 || new Set(ids).size !== ids.length) {
    throw fail('Attivazioni duplicate o assenti');
  }
  // La query collega SEMPRE offerta -> attivazione e operatore -> offerta.
  // FOR UPDATE blocca anche le righe lette; ordine deterministico per ID.
  const { rows } = await client.query(`
    SELECT a.id AS attivazione_id, a.autista_id AS operatore_id,
           a.veicolo_id, a.stato AS attivazione_stato,
           a.expires_at AS attivazione_scadenza,
           a.corsa_id,
           p.id AS accettazione_id, p.offerta_id,
           p.veicolo_id AS accettazione_veicolo_id,
           p.stato AS accettazione_stato,
           p.expires_at AS accettazione_scadenza,
           o.autista_id AS offerta_operatore_id,
           o.attivazione_id AS offerta_attivazione_id,
           o.stato AS offerta_stato,
           o.expires_at AS offerta_scadenza
    FROM popbus_attivazioni a
    JOIN popbus_ar_accettazioni p ON p.attivazione_id = a.id
    JOIN offerte_autisti o ON o.id = p.offerta_id
    WHERE a.id = ANY($1::bigint[])
    ORDER BY a.id
    FOR UPDATE OF a, p, o
  `, [ids]);
  if (rows.length !== ids.length) throw fail('Accettazioni/offerte mancanti');
  const now = Date.now();
  const mapped = rows.map((r, i) => {
    const id = positive(r.attivazione_id);
    if (id !== ids[i] ||
        positive(r.offerta_attivazione_id) !== id ||
        positive(r.operatore_id) !== positive(r.offerta_operatore_id) ||
        positive(r.veicolo_id) !== positive(r.accettazione_veicolo_id) ||
        r.corsa_id != null ||
        r.attivazione_stato !== 'in_attesa_autista' ||
        r.accettazione_stato !== 'provvisoria' ||
        r.offerta_stato !== 'inviata') {
      throw fail(`Identita' o stato incoerente per attivazione ${id}`);
    }
    for (const value of [r.attivazione_scadenza, r.accettazione_scadenza, r.offerta_scadenza]) {
      const expiry = new Date(value).getTime();
      if (!Number.isFinite(expiry) || expiry <= now) {
        throw fail(`Scadenza non valida per attivazione ${id}`);
      }
    }
    return Object.freeze({
      attivazioneId: id,
      offertaId: positive(r.offerta_id),
      operatoreId: positive(r.operatore_id),
      veicoloId: positive(r.veicolo_id)
    });
  });
  return Object.freeze(mapped);
}
