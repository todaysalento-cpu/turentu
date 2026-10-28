
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { pool } from '../db/db.js';
import { eseguiPixelInTransazione } from '../services/pixel/pixel-operational.service.js';
import { collaudaPixelFirstInTransazione } from '../services/popbus/v2/pixel-first-multimission-service.js';

const TEST_REQUEST_IDS = [...Array.from({ length: 12 }, (_, i) => 196 + i), 520, 521, 522, 523];
const EXPECTED_MISSIONS = 2;

function fingerprint({ start, end, ids, bufferMinuti }) {
  return createHash('sha256')
    .update(JSON.stringify({
      start,
      end,
      ids: [...new Set(ids.map(Number))].sort((a, b) => a - b),
      bufferMinuti
    }))
    .digest('hex');
}

async function leggiPrezzi(db) {
  const { rows } = await db.query(
    `SELECT id, prezzo
       FROM public.richieste_pop_bus
      WHERE id = ANY($1::integer[])
      ORDER BY id`,
    [TEST_REQUEST_IDS]
  );

  return rows.map(row => ({
    id: Number(row.id),
    prezzo: String(row.prezzo)
  }));
}

async function applicaFixtureEconomica(client) {
  const { rows } = await client.query(
    `SELECT id, prezzo, stato, corsa_id
       FROM public.richieste_pop_bus
      WHERE id = ANY($1::integer[])
      ORDER BY id
      FOR UPDATE`,
    [TEST_REQUEST_IDS]
  );

  assert.equal(rows.length, TEST_REQUEST_IDS.length,
    'Fixture: non sono presenti tutte le 12 richieste');

  for (const row of rows) {
    assert.equal(row.stato, 'in_attesa',
      `Fixture: richiesta ${row.id} non in attesa`);
    assert.equal(row.corsa_id, null,
      `Fixture: richiesta ${row.id} già associata a una corsa`);
    assert.ok(row.prezzo !== null && Number.isFinite(Number(row.prezzo))
      && Number(row.prezzo) > 0,
    `Fixture: prezzo non valido per richiesta ${row.id}`);
  }

  const prezziOriginali = rows.map(row => ({
    id: Number(row.id),
    prezzo: String(row.prezzo)
  }));

  const updated = await client.query(
    `UPDATE public.richieste_pop_bus
        SET prezzo = prezzo * 2
      WHERE id = ANY($1::integer[])
        AND stato = 'in_attesa'
        AND corsa_id IS NULL`,
    [TEST_REQUEST_IDS]
  );

  assert.equal(updated.rowCount, TEST_REQUEST_IDS.length,
    'Fixture: aggiornamento dei prezzi incompleto');

  const prezziTemporanei = await leggiPrezzi(client);

  for (let i = 0; i < prezziOriginali.length; i++) {
    assert.equal(prezziTemporanei[i].id, prezziOriginali[i].id);
    assert.ok(
      Math.abs(
        Number(prezziTemporanei[i].prezzo) -
        Number(prezziOriginali[i].prezzo) * 2
      ) < 0.000001,
      `Fixture: prezzo temporaneo incoerente per ${prezziOriginali[i].id}`
    );
  }

  return { prezziOriginali, prezziTemporanei };
}

async function verificaOpportunitaPixel(client, pixel, richiesteTemporaneeIds = []) {
  const pubblicazioni = pixel.pubblicazioni ?? [];
  const opportunityIds = [...new Set(
    pubblicazioni.flatMap(p => p.opportunityIds ?? []).map(Number)
  )].sort((a, b) => a - b);

  assert.ok(opportunityIds.length > 0,
    'PIXEL: nessuna opportunità pubblicata');

  assert.ok(opportunityIds.length <= 15,
    'PIXEL: troppe opportunità per il limite POPBUS V2');

  const { rows } = await client.query(
    `SELECT
        o.id AS opportunita_id,
        o.direttrice_id,
        o.inizio_finestra,
        o.fine_finestra,
        o.stato AS stato_opportunita,
        o.dati_temporali,
        d.stato AS stato_direttrice,
        d.versione,
        COALESCE(
          array_agg(por.richiesta_id ORDER BY por.richiesta_id)
            FILTER (WHERE por.richiesta_id IS NOT NULL),
          ARRAY[]::integer[]
        ) AS richiesta_ids
       FROM public.pixel_opportunita o
       JOIN public.pixel_direttrici d
         ON d.id = o.direttrice_id
       LEFT JOIN public.pixel_opportunita_richieste por
         ON por.opportunita_id = o.id
      WHERE o.id = ANY($1::bigint[])
      GROUP BY o.id, d.id
      ORDER BY o.id`,
    [opportunityIds]
  );

  assert.equal(rows.length, opportunityIds.length,
    'PIXEL: opportunità pubblicate non leggibili nella transazione');

  const pubblicazionePerId = new Map();
  for (const pubblicazione of pubblicazioni) {
    for (const id of pubblicazione.opportunityIds ?? []) {
      assert.ok(!pubblicazionePerId.has(Number(id)),
        `PIXEL: opportunità ${id} pubblicata più volte`);
      pubblicazionePerId.set(Number(id), pubblicazione);
    }
  }

  const dettaglio = [];

  for (const row of rows) {
    const id = Number(row.opportunita_id);
    const pubblicazione = pubblicazionePerId.get(id);

    assert.ok(pubblicazione,
      `PIXEL: opportunità ${id} senza pubblicazione`);
    assert.equal(Number(row.direttrice_id),
      Number(pubblicazione.direttricePixelId));
    assert.equal(Number(row.versione),
      Number(pubblicazione.versione));
    assert.equal(row.stato_opportunita, 'candidata');
    assert.equal(row.stato_direttrice, 'attiva');

    const ids = row.richiesta_ids.map(Number);
    assert.ok(ids.length > 0,
      `PIXEL: opportunità ${id} senza richieste`);

    const dati = row.dati_temporali ?? {};
    const expected = fingerprint({
      start: new Date(row.inizio_finestra).getTime(),
      end: new Date(row.fine_finestra).getTime(),
      ids,
      bufferMinuti: Number(dati.bufferMinuti ?? 0)
    });

    assert.equal(dati.fingerprint, expected,
      `PIXEL: fingerprint incoerente per opportunità ${id}`);

    dettaglio.push({
      opportunitaId: id,
      direttriceId: Number(row.direttrice_id),
      versione: Number(row.versione),
      richiestaIds: ids,
      fingerprintVerificato: true
    });
  }

  const nuoveRichieste = [520, 521, 522, 523, ...richiesteTemporaneeIds];
  const richiesteAssociate = new Set(dettaglio.flatMap(o => o.richiestaIds));
  for (const id of nuoveRichieste) {
    assert.ok(richiesteAssociate.has(id), 'PIXEL: richiesta ' + id + ' non associata alle opportunita pubblicate');
  }
  console.log('[PIXEL] Richieste 520-523 associate alle opportunita: PASS');

  return { opportunityIds, dettaglio };
}

async function verificaPersistenzaInterna(client, popbus, opportunityIds) {
  assert.equal(popbus.offerte, 1,
    `Fixture positiva: attesa un'offerta, ottenute ${popbus.offerte}. ` +
    `${popbus.motivo ?? ''}`);

  const attivazioneId = Number(popbus.attivazioneId);
  const offertaId = Number(popbus.offertaId);

  assert.ok(Number.isSafeInteger(attivazioneId) && attivazioneId > 0,
    'POPBUS: attivazioneId non valido');
  assert.ok(Number.isSafeInteger(offertaId) && offertaId > 0,
    'POPBUS: offertaId non valido');

  const attivazione = await client.query(
    `SELECT id, direttrice_id, veicolo_id, autista_id,
            costo, ricavo, piano
       FROM public.popbus_attivazioni
      WHERE id = $1`,
    [attivazioneId]
  );

  assert.equal(attivazione.rowCount, 1,
    'POPBUS: attivazione non persistita nella transazione');
  assert.equal(attivazione.rows[0].direttrice_id, null,
    'POPBUS: riferimento legacy nella attivazione');

  const offerta = await client.query(
    `SELECT id, attivazione_id, direttrice_id
       FROM public.offerte_autisti
      WHERE id = $1`,
    [offertaId]
  );

  assert.equal(offerta.rowCount, 1,
    'POPBUS: offerta non persistita nella transazione');
  assert.equal(Number(offerta.rows[0].attivazione_id), attivazioneId);
  assert.equal(offerta.rows[0].direttrice_id, null,
    'POPBUS: riferimento legacy nella offerta');

  const missioni = await client.query(
    `SELECT id, ordine, direttrice_id, pixel_opportunita_id
       FROM public.popbus_attivazione_missioni
      WHERE attivazione_id = $1
      ORDER BY ordine`,
    [attivazioneId]
  );

  assert.equal(missioni.rowCount, EXPECTED_MISSIONS,
    'POPBUS: attese esattamente due missioni');

  const idsMissioni = missioni.rows.map(m => Number(m.id));
  const idsOpportunita = missioni.rows.map(
    m => Number(m.pixel_opportunita_id)
  );

  assert.equal(new Set(idsOpportunita).size, EXPECTED_MISSIONS,
    'POPBUS: le due missioni devono riferirsi a opportunità distinte');

  for (const missione of missioni.rows) {
    assert.equal(missione.direttrice_id, null,
      'POPBUS: missione con riferimento legacy');
    assert.ok(
      opportunityIds.includes(Number(missione.pixel_opportunita_id)),
      'POPBUS: missione non proveniente da PIXEL E2E'
    );
  }

  const associazioni = await client.query(
    `SELECT missione_id, richiesta_id
       FROM public.popbus_missione_richieste
      WHERE missione_id = ANY($1::bigint[])
      ORDER BY missione_id, richiesta_id`,
    [idsMissioni]
  );

  assert.ok(associazioni.rowCount >= EXPECTED_MISSIONS,
    'POPBUS: associazioni missione-richiesta mancanti');

  const attivazioneRichieste = await client.query(
    `SELECT richiesta_id, attiva
       FROM public.popbus_attivazione_richieste
      WHERE attivazione_id = $1
      ORDER BY richiesta_id`,
    [attivazioneId]
  );

  const richiestaIds = [...new Set(
    attivazioneRichieste.rows.map(r => Number(r.richiesta_id))
  )];

  assert.ok(richiestaIds.length > 0,
    'POPBUS: attivazione priva di richieste');

  assert.ok(attivazioneRichieste.rows.every(r => r.attiva === true),
    'POPBUS: associazioni attivazione-richiesta non attive');

  assert.deepEqual(
    [...new Set(associazioni.rows.map(r => Number(r.richiesta_id)))].sort((a, b) => a - b),
    [...richiestaIds].sort((a, b) => a - b),
    'POPBUS: richieste missioni diverse dalle richieste attivazione'
  );

  return {
    attivazioneId,
    offertaId,
    missioniIds: idsMissioni,
    opportunitaIds: idsOpportunita,
    richiestaIds,
    missioniRegistrate: missioni.rowCount,
    associazioniMissioneRichiesta: associazioni.rowCount,
    margineEuro: popbus.margineEuro ?? null
  };
}

async function verificaRollbackEsterno(verifica, prezziOriginali) {
  const prezziRipristinati = await leggiPrezzi(pool);

  assert.deepEqual(
    prezziRipristinati,
    prezziOriginali,
    'ROLLBACK: prezzi originali non ripristinati'
  );

  if (verifica.esito === 'NON_ATTIVABILE') {
    return { confermato: true, prezziOriginaliRipristinati: true, nessunaOffertaGenerata: true };
  }

  const attivazione = await pool.query(
    `SELECT id FROM public.popbus_attivazioni WHERE id = $1`,
    [verifica.attivazioneId]
  );

  const offerta = await pool.query(
    `SELECT id FROM public.offerte_autisti WHERE id = $1`,
    [verifica.offertaId]
  );

  const missioni = await pool.query(
    `SELECT id FROM public.popbus_attivazione_missioni
      WHERE attivazione_id = $1`,
    [verifica.attivazioneId]
  );

  const associazioni = await pool.query(
    `SELECT richiesta_id FROM public.popbus_attivazione_richieste
      WHERE attivazione_id = $1`,
    [verifica.attivazioneId]
  );

  const missioneRichieste = await pool.query(
    `SELECT missione_id FROM public.popbus_missione_richieste
      WHERE missione_id = ANY($1::bigint[])`,
    [verifica.missioniIds]
  );

  assert.equal(attivazione.rowCount, 0,
    'ROLLBACK: attivazione ancora presente');
  assert.equal(offerta.rowCount, 0,
    'ROLLBACK: offerta ancora presente');
  assert.equal(missioni.rowCount, 0,
    'ROLLBACK: missioni ancora presenti');
  assert.equal(associazioni.rowCount, 0,
    'ROLLBACK: associazioni attivazione ancora presenti');
  assert.equal(missioneRichieste.rowCount, 0,
    'ROLLBACK: associazioni missioni ancora presenti');

  return {
    confermato: true,
    prezziOriginaliRipristinati: true,
    attivazioneAssente: true,
    offertaAssente: true,
    missioniAssenti: true,
    associazioniAssenti: true
  };
}

async function inserisciRichiesteEconomiche(client) {
  const result = await client.query(`
    INSERT INTO richieste_pop_bus (
      cliente_id, origine, destinazione, start_datetime,
      posti_richiesti, stato, classe,
      origine_nodo_territoriale_id, destinazione_nodo_territoriale_id,
      origine_address, destinazione_address, prezzo,
      payment_intent_id, request_id
    )
    SELECT
      r.cliente_id, r.origine, r.destinazione, r.start_datetime,
      r.posti_richiesti, 'in_attesa', r.classe,
      r.origine_nodo_territoriale_id, r.destinazione_nodo_territoriale_id,
      r.origine_address, r.destinazione_address, r.prezzo,
      r.payment_intent_id, gen_random_uuid()
    FROM richieste_pop_bus r
    CROSS JOIN generate_series(1, 2) AS n
    WHERE r.id = 523
    RETURNING id
  `);
  assert.equal(result.rowCount, 2, 'Fixture: attese due richieste');
  return result.rows.map(r => Number(r.id));
}

async function main() {
  const client = await pool.connect();

  let transazioneAperta = false;
  let rollbackConfermato = false;
  let rollbackError = null;
  let errore = null;
  let prezziOriginali = null;
  let verifica = null;
  let pixel = null;
  let popbus = null;
  let provenienza = null;

  try {
    prezziOriginali = await leggiPrezzi(client);
    await client.query(
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE'
    );
    transazioneAperta = true;

    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SET LOCAL idle_in_transaction_session_timeout = '600000'"
    );

    const now = new Date();

    const nuoveRichiesteIds = await inserisciRichiesteEconomiche(client);
    console.log('[E2E NUOVA DOMANDA]', JSON.stringify({ richiesteInserite: nuoveRichiesteIds, ricavoAggiuntivoPotenzialeEuro: 28, rollbackOnly: true }));

    pixel = await eseguiPixelInTransazione({
      client,
      now,
      maxRichieste: 100,
      maxDirettrici: 500,
      abilitaVariantiP1: true,
      bufferMinuti: 0
    });

    assert.equal(pixel.committed, false,
      'PIXEL: il servizio non deve eseguire COMMIT');

    provenienza = await verificaOpportunitaPixel(client, pixel, nuoveRichiesteIds);

    popbus = await collaudaPixelFirstInTransazione({
      client,
      now: now.getTime(),
      opportunityIds: provenienza.opportunityIds
    });

    assert.ok(popbus.offerte === 0 || popbus.offerte === 1, 'POPBUS: numero offerte inatteso');
    if (popbus.offerte === 1) {
      verifica = await verificaPersistenzaInterna(client, popbus, provenienza.opportunityIds);
    } else {
      verifica = { esito: 'NON_ATTIVABILE', motivo: popbus.motivo ?? 'Nessun ciclo sostenibile', cicliValutati: popbus.cicliValutati ?? null };
    }
  } catch (e) {
    errore = e;
  } finally {
    if (transazioneAperta) {
      try {
        await client.query('ROLLBACK');
        rollbackConfermato = true;
        console.log('[E2E ROLLBACK] Confermato');
      } catch (e) {
        rollbackError = e;
        console.error('[E2E ROLLBACK ERRORE]', e);
      }
    }

    client.release(Boolean(rollbackError));
  }

  if (rollbackError) {
    throw new AggregateError(
      [errore, rollbackError].filter(Boolean),
      'E2E: rollback non confermato'
    );
  }

  if (!rollbackConfermato) {
    throw new Error('E2E: rollback non eseguito');
  }

  if (errore) {
    console.error('[E2E ERRORE DOPO ROLLBACK]', errore);
    throw errore;
  }

  const rollback = await verificaRollbackEsterno(verifica, prezziOriginali);

  console.log('[E2E PIXEL POPBUS V2 - ECONOMIA REALE]', JSON.stringify({
    modalita: 'E2E_REAL_ECONOMICS_ROLLBACK',
    prezziOriginaliInvariati: true,
    richiesteMonitorate: TEST_REQUEST_IDS,
    pixel: {
      richiesteEsaminate: pixel.richiesteEsaminate,
      direttriciPubblicate: pixel.direttriciPubblicate,
      opportunitaPubblicate: provenienza.opportunityIds.length,
      opportunityIds: provenienza.opportunityIds,
      dettaglioOpportunita: provenienza.dettaglio
    },
    popbus: { ...popbus, verifica },
    rollback,
    persistita: false
  }, null, 2));
  console.log('[E2E ESITO]', popbus.offerte === 1 ? 'CICLO ATTIVABILE - rollback confermato' : 'CICLO NON ATTIVABILE - rollback confermato');
}

main()
  .catch(error => {
    console.error('[E2E ERRORE]', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
