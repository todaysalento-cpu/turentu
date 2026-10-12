// La transazione è gestita dal worker chiamante.
// Questo servizio valuta il pool: non prenota né assegna un veicolo.

export function analizzaPercorso(segmenti, richieste, partenza) {
  if (!segmenti.length) {
    throw new Error('Direttrice senza segmenti');
  }

  const nodi = [Number(segmenti[0].start_node_id)];
  let transito = new Date(partenza).getTime();

  if (!Number.isFinite(transito)) {
    throw new Error('Partenza direttrice non valida');
  }

  const analisi = segmenti.map((s, i) => {
    const durata =
      s.tempo_stimato == null ? NaN : Number(s.tempo_stimato);

    if (
      Number(s.ordine_sequenziale) !== i + 1 ||
      Number(s.start_node_id) !== nodi[i] ||
      !Number.isFinite(durata) ||
      durata <= 0
    ) {
      throw new Error('Sequenza o durata segmenti non valida');
    }

    if (
      s.start_datetime != null &&
      new Date(s.start_datetime).getTime() !== transito
    ) {
      throw new Error(
        `Orario incoerente del segmento ${s.id}: ` +
        'richiede verifica, non viene sovrascritto'
      );
    }

    const result = {
      ...s,
      transito: new Date(transito),
      occupazione: 0,
      ricavo: 0
    };

    nodi.push(Number(s.end_node_id));
    transito += durata * 60000;

    return result;
  });

  if (new Set(nodi).size !== nodi.length) {
    throw new Error('Percorso con nodi ripetuti non supportato');
  }

  for (const r of richieste) {
    const start = nodi.indexOf(Number(r.start_node_id));
    const end = nodi.indexOf(Number(r.end_node_id));
    const posti = Number(r.posti_richiesti);
    const prezzo = r.prezzo == null ? NaN : Number(r.prezzo);

    if (
      start < 0 ||
      end <= start ||
      !Number.isInteger(posti) ||
      posti <= 0 ||
      !Number.isFinite(prezzo) ||
      prezzo < 0
    ) {
      throw new Error(`Richiesta ${r.id} non valida sul percorso`);
    }

    const requested =
      r.start_datetime == null
        ? NaN
        : new Date(r.start_datetime).getTime();

    if (
      !Number.isFinite(requested) ||
      Math.abs(
        requested - analisi[start].transito.getTime()
      ) > 30 * 60000
    ) {
      throw new Error(
        `Richiesta ${r.id} fuori tolleranza di salita ±30 minuti`
      );
    }

    for (let i = start; i < end; i++) {
      analisi[i].occupazione += posti;

      // Ricavo dei clienti che attraversano il segmento.
      // Non sommare questi valori per ottenere il ricavo
      // complessivo della direttrice: una richiesta può
      // attraversare più segmenti.
      analisi[i].ricavo += prezzo;
    }
  }

  return {
    segmenti: analisi,
    picco: Math.max(...analisi.map(s => s.occupazione)),
    arrivo: new Date(transito)
  };
}

export async function calcolaAttivazioneEconomica(
  client,
  segmentiCoinvoltiIds
) {
  if (!Array.isArray(segmentiCoinvoltiIds)) {
    throw new Error('Elenco segmenti non valido');
  }

  const ids = [
    ...new Set(segmentiCoinvoltiIds.map(Number))
  ];

  if (
    ids.some(
      id =>
        !Number.isInteger(id) ||
        id <= 0 ||
        id > 2147483647
    )
  ) {
    throw new Error('ID segmento non valido');
  }

  if (!ids.length) return [];

  await client.query(
    'SELECT pg_advisory_xact_lock(734021, 1)'
  );

  const { rows: dirs } = await client.query(`
    SELECT
      d.id,
      d.partenza_prevista,
      d.veicolo_id
    FROM direttrici_virtuali d
    WHERE d.stato = 'in_formazione'
      AND EXISTS (
        SELECT 1
        FROM segmenti s
        WHERE s.direttrice_id = d.id
          AND s.id = ANY($1::int[])
      )
    ORDER BY d.id
    FOR UPDATE OF d
  `, [ids]);

  const attivati = [];

  for (const d of dirs) {
    const { rows: segmenti } = await client.query(`
      SELECT
        s.id,
        s.direttrice_id,
        s.start_node_id,
        s.end_node_id,
        s.ordine_sequenziale,
        s.tempo_stimato,
        s.start_datetime,
        s.stato,
        s.posti_impegnati,

        ST_Distance(
          n1.posizione::geography,
          n2.posizione::geography
        ) / 1000 AS km_tratta,

        COALESCE((
          SELECT MAX(
            ST_Distance(
              no.posizione::geography,
              n1.posizione::geography
            ) / 1000
            +
            ST_Distance(
              n2.posizione::geography,
              ne.posizione::geography
            ) / 1000
          )
          FROM missioni_ritorno m
          JOIN nodi_direttrice no
            ON no.id = m.nodo_origine
          JOIN nodi_direttrice ne
            ON ne.id = m.capolinea_finale_id
          WHERE m.segmento_id = s.id
        ), 0) AS km_accessori

      FROM segmenti s
      JOIN nodi_direttrice n1
        ON n1.id = s.start_node_id
      JOIN nodi_direttrice n2
        ON n2.id = s.end_node_id
      WHERE s.direttrice_id = $1
      ORDER BY s.ordine_sequenziale, s.id
      FOR UPDATE OF s
    `, [d.id]);

    // Non ricalcolare occupazione su direttrici operative
    // o con impegni di cui non è ancora chiarita la semantica.
    if (
      !segmenti.length ||
      segmenti.some(
        s =>
          s.stato !== 'in_attesa' ||
          Number(s.posti_impegnati || 0) !== 0
      )
    ) {
      continue;
    }

    const { rows: richieste } = await client.query(`
      SELECT
        id,
        start_node_id,
        end_node_id,
        start_datetime,
        posti_richiesti,
        prezzo
      FROM richieste_pop_bus
      WHERE direttrice_id = $1
        AND stato IN ('in_attesa', 'in_lavorazione')
      ORDER BY id
      FOR UPDATE
    `, [d.id]);

    if (!richieste.length) continue;

    let percorso;

    try {
      percorso = analizzaPercorso(
        segmenti,
        richieste,
        d.partenza_prevista
      );
    } catch (err) {
      console.warn(
        `[ECONOMIA] Direttrice ${d.id} rinviata: ${err.message}`
      );

      // Viene gestito soltanto un errore di validazione JS.
      // Gli errori SQL si propagano al worker per il rollback.
      continue;
    }

    const { rows: veicoli } = await client.query(`
      SELECT
        v.id AS veicolo_id,
        v.posti_totali,
        t.euro_km

      FROM veicolo v

      JOIN LATERAL (
        SELECT MIN(euro_km) AS euro_km
        FROM tariffe
        WHERE veicolo_id = v.id
          AND tipo = 'standard'
          AND euro_km > 0
      ) t ON t.euro_km IS NOT NULL

      WHERE v.driver_id IS NOT NULL
        AND v.posti_totali >= $1

        AND (
          $3::int IS NULL
          OR v.id = $3::int
        )

        AND EXISTS (
          SELECT 1
          FROM disponibilita_veicolo dv
          WHERE dv.veicolo_id = v.id
        )

        AND NOT EXISTS (
          SELECT 1
          FROM direttrici_virtuali other
          JOIN veicolo ov
            ON ov.id = other.veicolo_id
          WHERE other.id <> $2
            AND other.stato IN (
              'in_formazione',
              'in_attesa_autista',
              'attivo',
              'confermata'
            )
            AND (
              ov.id = v.id
              OR ov.driver_id = v.driver_id
            )
        )

      ORDER BY t.euro_km, v.id
    `, [
      percorso.picco,
      d.id,
      d.veicolo_id
    ]);

    // Nessuna capacità o tariffa inventata se il pool è vuoto.
    const veicolo = veicoli[0];

    if (!veicolo) {
      console.log(
        `[ECONOMIA] Direttrice ${d.id}: ` +
        'nessun mezzo con tariffa standard e ' +
        `capienza ${percorso.picco}`
      );
      continue;
    }

    const tariffa = Number(veicolo.euro_km);

    if (!Number.isFinite(tariffa) || tariffa <= 0) {
      continue;
    }

    // Mantiene l'attivazione di al massimo un segmento
    // per direttrice in questo ciclo.
    const candidato = percorso.segmenti.find(s => {
      const km =
        Number(s.km_tratta) + Number(s.km_accessori);

      return (
        ids.includes(Number(s.id)) &&
        s.occupazione > 0 &&
        Number.isFinite(km) &&
        km > 0 &&
        s.ricavo >= km * tariffa
      );
    });

    if (!candidato) continue;

    const { rows: updated } = await client.query(`
      UPDATE segmenti
      SET
        stato = 'attivo',
        ricavo_stimato = $2,
        posti_occupati = $3,
        start_datetime = COALESCE(
          start_datetime,
          $4::timestamptz
        )
      WHERE id = $1
        AND stato = 'in_attesa'
      RETURNING
        id,
        direttrice_id,
        stato,
        start_node_id,
        ricavo_stimato,
        posti_occupati
    `, [
      candidato.id,
      candidato.ricavo,
      candidato.occupazione,
      candidato.transito
    ]);

    attivati.push(...updated);

    console.log(
      `[ECONOMIA] Direttrice ${d.id}, ` +
      `segmento ${candidato.id}: ` +
      `picco ${percorso.picco}, ` +
      `mezzo di riferimento ${veicolo.veicolo_id}, ` +
      `tariffa ${tariffa} €/km ` +
      '(assegnazione da verificare)'
    );
  }

  return attivati;
}