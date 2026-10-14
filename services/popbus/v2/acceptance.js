import { fingerprintRichiesta } from './request-fingerprint.js';

import Stripe from 'stripe';
import polyline from 'polyline';
import * as turf from '@turf/turf';

export async function verificaPagamento(client, r) {
  const ref = r.payment_intent_id;

  if (!ref) {
    throw new Error(
      `Richiesta ${r.id}: pagamento non collegato, riconciliare prima di accettare`
    );
  }

  if (ref.startsWith('wallet_')) {
    const { rows } = await client.query(
      `SELECT COALESCE(SUM(importo), 0) AS totale
       FROM transazioni_wallet
       WHERE utente_id = $1
         AND riferimento_id::text = $2`,
      [r.cliente_id, String(r.request_id)]
    );

    if (Number(rows[0].totale) > -Number(r.prezzo)) {
      throw new Error('Addebito wallet non verificato');
    }

    return 'pagato';
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe non configurato');
  }

  const pi = await new Stripe(
    process.env.STRIPE_SECRET_KEY
  ).paymentIntents.retrieve(ref);

  if (
    pi.currency !== 'eur' ||
    String(pi.metadata?.clienteId) !== String(r.cliente_id) ||
    pi.status !== 'requires_capture' ||
    pi.amount_capturable < Math.round(Number(r.prezzo) * 100)
  ) {
    throw new Error(
      `Richiesta ${r.id}: autorizzazione pagamento non valida`
    );
  }

  return 'autorizzazione';
}

export async function accettaAttivazione(
  client,
  offertaId,
  autistaId
) {
  // BEGIN / COMMIT sono gestiti dal router.
  // Nessuna cache o notifica viene aggiornata qui.

  await client.query(
    'SELECT pg_advisory_xact_lock(734021, 1)'
  );

  // =====================================================
  // 1. BLOCCO E VERIFICA OFFERTA
  // =====================================================

  const { rows: offers } = await client.query(
    `
    SELECT
      o.*,
      a.stato AS att_stato,
      a.corsa_id
    FROM offerte_autisti o
    JOIN popbus_attivazioni a
      ON a.id = o.attivazione_id
    WHERE o.id = $1
      AND o.autista_id = $2
    FOR UPDATE OF o, a
    `,
    [offertaId, autistaId]
  );

  const offer = offers[0];

  if (!offer) {
    throw new Error('Offerta non trovata o non tua');
  }

  if (
    offer.stato === 'accettata' &&
    offer.corsa_id
  ) {
    return {
      id: offer.corsa_id,
      giaAccettata: true
    };
  }

  if (
    offer.stato !== 'inviata' ||
    offer.att_stato !== 'in_attesa_autista' ||
    new Date(offer.expires_at) <= new Date()
  ) {
    throw new Error('Offerta non disponibile');
  }

  // =====================================================
  // 2. RECUPERO ATTIVAZIONE E PIANO
  // =====================================================

  const { rows: acts } = await client.query(
    `
    SELECT *
    FROM popbus_attivazioni
    WHERE id = $1
    FOR UPDATE
    `,
    [offer.attivazione_id]
  );

  const a = acts[0];

  if (!a) {
    throw new Error('Attivazione non trovata');
  }

  const plan = a.piano;

  if (
    !plan ||
    !plan.evaluation ||
    !plan.busyStart ||
    !plan.busyEnd
  ) {
    throw new Error('Piano attivazione non valido');
  }

  const busyStart = new Date(plan.busyStart);
  const busyEnd = new Date(plan.busyEnd);

  if (
    !Number.isFinite(busyStart.getTime()) ||
    !Number.isFinite(busyEnd.getTime()) ||
    busyStart >= busyEnd
  ) {
    throw new Error('Intervallo temporale attivazione non valido');
  }

  // =====================================================
  // 3. VERIFICA VEICOLO
  // =====================================================

  const { rows: vs } = await client.query(
    `
    SELECT *
    FROM veicolo
    WHERE id = $1
      AND driver_id = $2
    FOR UPDATE
    `,
    [a.veicolo_id, autistaId]
  );

  if (
    !vs.length ||
    Number(vs[0].posti_totali) <
      Number(plan.evaluation.peak)
  ) {
    throw new Error('Mezzo non più idoneo');
  }

  // =====================================================
  // 4. CONTROLLO CONFLITTI CORSE ESISTENTI
  //
  // FIX:
  // Una corsa futura con arrivo_datetime NULL
  // non deve bloccare una missione precedente.
  // =====================================================

  const { rows: conflicts } = await client.query(
    `
    SELECT
      c.id,
      c.veicolo_id,
      v.driver_id,
      c.stato,
      c.start_datetime,
      c.arrivo_datetime
    FROM corse c
    JOIN veicolo v
      ON v.id = c.veicolo_id
    WHERE
      (
        v.id = $1
        OR v.driver_id = $2
      )
      AND c.stato IN (
        'prenotabile',
        'in_corso',
        'da_attivare'
      )
      AND c.start_datetime < $4::timestamptz
      AND (
        c.arrivo_datetime IS NULL
        OR c.arrivo_datetime > $3::timestamptz
      )
    LIMIT 10
    `,
    [
      a.veicolo_id,
      autistaId,
      busyStart,
      busyEnd
    ]
  );

  if (conflicts.length > 0) {
    console.warn(
      '❌ [POPBUS ACCETTA] CONFLITTO CORSA',
      {
        offertaId,
        attivazioneId: a.id,
        veicoloId: a.veicolo_id,
        autistaId,
        busyStart: busyStart.toISOString(),
        busyEnd: busyEnd.toISOString(),
        corseConflitto: conflicts
      }
    );

    throw new Error('Autista o mezzo impegnato');
  }

  // =====================================================
  // 5. CONTROLLO ALTRE ATTIVAZIONI POPBUS
  //
  // Escludiamo esplicitamente l'attivazione corrente.
  // =====================================================

  const { rows: activationConflicts } = await client.query(
    `
    SELECT
      other.id,
      other.veicolo_id,
      other.autista_id,
      other.stato,
      other.partenza,
      other.arrivo,
      other.piano->>'busyStart' AS busy_start,
      other.piano->>'busyEnd' AS busy_end
    FROM popbus_attivazioni other
    WHERE other.id <> $1
      AND (
        other.veicolo_id = $2
        OR other.autista_id = $3
      )
      AND other.stato = 'confermata'
      AND COALESCE(
        (other.piano->>'busyStart')::timestamptz,
        other.partenza
      ) < $5::timestamptz
      AND COALESCE(
        (other.piano->>'busyEnd')::timestamptz,
        other.arrivo
      ) > $4::timestamptz
    LIMIT 10
    `,
    [
      a.id,
      a.veicolo_id,
      autistaId,
      busyStart,
      busyEnd
    ]
  );

  if (activationConflicts.length > 0) {
    console.warn(
      '❌ [POPBUS ACCETTA] CONFLITTO ATTIVAZIONE',
      {
        offertaId,
        attivazioneId: a.id,
        attivazioniConflitto: activationConflicts
      }
    );

    throw new Error(
      'Autista o mezzo già assegnato ad altra attivazione POPBUS'
    );
  }

  console.log(
    '✅ [POPBUS ACCETTA] Disponibilità verificata',
    {
      offertaId,
      attivazioneId: a.id,
      veicoloId: a.veicolo_id,
      autistaId,
      busyStart: busyStart.toISOString(),
      busyEnd: busyEnd.toISOString()
    }
  );

  // =====================================================
  // 6. LOCK RICHIESTE POPBUS
  // =====================================================

  const { rows: requests } = await client.query(
    `
    SELECT
      r.*,
      ar.indice_salita,
      ar.indice_discesa
    FROM richieste_pop_bus r
    JOIN popbus_attivazione_richieste ar
      ON ar.richiesta_id = r.id
    WHERE ar.attivazione_id = $1
      AND ar.attiva
    ORDER BY r.id
    FOR UPDATE OF r, ar
    `,
    [a.id]
  );

  if (
    requests.length !== plan.evaluation.requests.length ||
    requests.some(
      r =>
        r.stato !== 'in_lavorazione' ||
        r.corsa_id != null
    )
  ) {
    throw new Error('Richieste modificate');
  }

  // =====================================================
  // 7. VALIDAZIONE SNAPSHOT E ORARI
  // =====================================================

  for (const r of requests) {
    const fingerprint = fingerprintRichiesta(r);

    if (
      !plan.requestSnapshot.some(
        x =>
          Number(x.id) === Number(r.id) &&
          x.fingerprint === fingerprint
      )
    ) {
      throw new Error(
        'Dati richiesta modificati dopo offerta'
      );
    }

    const expected =
      plan.evaluation.departure +
      plan.evaluation.times[r.indice_salita];

    if (
      Math.abs(
        new Date(r.start_datetime).getTime() - expected
      ) > 1800000
    ) {
      throw new Error('Orario richiesta modificato');
    }
  }

  // =====================================================
  // 8. VERIFICA PAGAMENTI
  // =====================================================

  const states = [];

  for (const r of requests) {
    states.push(
      await verificaPagamento(client, r)
    );
  }

  // =====================================================
  // 9. RICOSTRUZIONE GEOMETRIA E OFFSET
  // =====================================================

  const coords = [];
  const indices = [0];
  const offsets = [0];

  for (const l of plan.legs) {
    const decoded = polyline.decode(l.polyline);

    if (decoded.length < 2) {
      throw new Error('Geometria non valida');
    }

    coords.push(
      ...(coords.length
        ? decoded.slice(1)
        : decoded)
    );

    indices.push(coords.length - 1);

    const metres =
      turf.length(
        turf.lineString(
          decoded.map(p => [p[1], p[0]])
        ),
        { units: 'kilometers' }
      ) * 1000;

    offsets.push(
      offsets.at(-1) + metres
    );
  }

  // =====================================================
  // 10. ORIGINE, DESTINAZIONE E FERMATE
  // =====================================================

  const origin = plan.coordinates[0];
  const dest = plan.coordinates.at(-1);

  const stops = [];

  for (const r of requests) {
    for (const [i, tipo] of [
      [r.indice_salita, 'ritiro'],
      [r.indice_discesa, 'rilascio']
    ]) {
      const n = plan.coordinates[i];

      stops.push({
        cliente_id: r.cliente_id,
        tipo,
        nodo_id: n.id,
        lat: n.lat,
        lon: n.lon,
        indirizzo: n.nome_nodo || 'Fermata',
        ordine: i,
        orario: new Date(
          plan.evaluation.departure +
          plan.evaluation.times[i]
        ).toISOString()
      });
    }
  }

  stops.sort(
    (x, y) =>
      x.ordine - y.ordine ||
      (x.tipo === 'rilascio' ? -1 : 1)
  );

  // =====================================================
  // 11. CREAZIONE CORSA POPBUS
  // =====================================================

  const { rows: corse } = await client.query(
    `
    INSERT INTO corse (
      veicolo_id,
      start_datetime,
      arrivo_datetime,
      durata,
      tipo_corsa,
      stato,
      posti_totali,
      posti_disponibili,
      posti_prenotati,
      origine,
      destinazione,
      origine_address,
      destinazione_address,
      distanza,
      percorso_polyline,
      fermate_pianificate,
      km_avvicinamento,
      km_riposizionamento
    )
    VALUES (
      $1,
      $2,
      $3,
      $4::double precision * INTERVAL '1 second',
      'riempimento',
      'prenotabile',
      $5,
      $5,
      0,
      ST_SetSRID(ST_MakePoint($6,$7),4326),
      ST_SetSRID(ST_MakePoint($8,$9),4326),
      $10,
      $11,
      $12,
      $13,
      $14::jsonb,
      $15,
      $16
    )
    RETURNING *
    `,
    [
      a.veicolo_id,
      a.partenza,
      a.arrivo,
      (new Date(a.arrivo) - new Date(a.partenza)) / 1000,
      vs[0].posti_totali,
      origin.lon,
      origin.lat,
      dest.lon,
      dest.lat,
      origin.nome_nodo || 'Partenza',
      dest.nome_nodo || 'Arrivo',
      offsets.at(-1) / 1000,
      polyline.encode(coords),
      JSON.stringify(stops),
      plan.approach.metres / 1000,
      plan.returnTrip.metres / 1000
    ]
  );

  const corsa = corse[0];

  // =====================================================
  // 12. CREAZIONE PRENOTAZIONI E PAGAMENTI
  // =====================================================

  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];

    const s = r.indice_salita;
    const e = r.indice_discesa;

    const start = plan.coordinates[s];
    const end = plan.coordinates[e];

    const { rows: ps } = await client.query(
      `
      INSERT INTO prenotazioni (
        corsa_id,
        cliente_id,
        posti_richiesti,
        posti_prenotati,
        prezzo_totale,
        start_index_polyline,
        end_index_polyline,
        start_offset,
        end_offset,
        km_utente,
        lat_salita,
        lon_salita,
        lat_discesa,
        lon_discesa
      )
      VALUES (
        $1,$2,$3,$3,$4,$5,$6,
        $7,$8,$9,$10,$11,$12,$13
      )
      RETURNING id
      `,
      [
        corsa.id,
        r.cliente_id,
        r.posti_richiesti,
        r.prezzo,
        indices[s],
        indices[e],
        offsets[s],
        offsets[e],
        (offsets[e] - offsets[s]) / 1000,
        start.lat,
        start.lon,
        end.lat,
        end.lon
      ]
    );

    await client.query(
      `
      INSERT INTO pagamenti (
        prenotazione_id,
        corsa_id,
        importo,
        stato,
        stripe_payment_intent,
        tipo_corsa
      )
      VALUES (
        $1,$2,$3,$4,$5,'riempimento'
      )
      `,
      [
        ps[0].id,
        corsa.id,
        r.prezzo,
        states[i],
        r.payment_intent_id
      ]
    );

    await client.query(
      `
      UPDATE richieste_pop_bus
      SET stato = 'convertita',
          corsa_id = $2
      WHERE id = $1
      `,
      [r.id, corsa.id]
    );
  }

  // =====================================================
  // 13. AGGIORNAMENTO POSTI
  // =====================================================

  await client.query(
    `
    UPDATE corse
    SET
      posti_prenotati = $2,
      posti_disponibili = posti_totali - $3
    WHERE id = $1
    `,
    [
      corsa.id,
      requests.reduce(
        (s, r) => s + Number(r.posti_richiesti),
        0
      ),
      plan.evaluation.peak
    ]
  );

  // =====================================================
  // 14. CONFERMA ATTIVAZIONE E OFFERTA
  // =====================================================

  await client.query(
    `
    UPDATE popbus_attivazioni
    SET stato = 'confermata',
        corsa_id = $2
    WHERE id = $1
    `,
    [a.id, corsa.id]
  );

  await client.query(
    `
    UPDATE offerte_autisti
    SET stato = 'accettata'
    WHERE id = $1
    `,
    [offer.id]
  );

  // Il contenitore e i suoi segmenti non vengono chiusi.

  // =====================================================
  // 15. RITORNO CORSA AGGIORNATA
  // =====================================================

  const { rows: updated } = await client.query(
    `
    SELECT *
    FROM corse
    WHERE id = $1
    `,
    [corsa.id]
  );

  console.log(
    '✅ [POPBUS ACCETTA] Corsa creata',
    {
      offertaId,
      attivazioneId: a.id,
      corsaId: corsa.id,
      veicoloId: a.veicolo_id,
      richieste: requests.length
    }
  );

  return updated[0];
}
