// TURENTU — E2E territoriale PIXEL -> POPBUS, SOLO ROLLBACK.
// Copiare in tests/e2e_pixel_popbus_sintetico_rollback.js
// Eseguire su DATABASE DI STAGING:
// node --env-file=.env tests/e2e_pixel_popbus_sintetico_rollback.js
// Non certifica il motore fisico delle fermate POPBUS V2.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/db.js';
import { leg } from '../services/popbus/v2/planner.js';
import { eseguiPixelInTransazione } from '../services/pixel/pixel-operational.service.js';
import { collaudaPixelFirstInTransazione } from '../services/popbus/v2/pixel-first-multimission-service.js';

const NODI = [8, 5, 7];
const PREZZO_TEST = 250; // Solo nella transazione: volutamente elevato per isolare la compatibilita.
const unique = values => [...new Set(values.map(Number))];
const day = new Date(Date.now() + 14 * 86400000);
day.setUTCHours(9, 0, 0, 0);
const secondStart = new Date(day.getTime() + 3 * 3600000);
let client;
let tx = false;
let failed = false;
let inserted = [];
let opportunityIds = [];
let activationId = null;
let offerId = null;
let missionIds = [];

try {
  client = await pool.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
  tx = true;
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '180s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '600000'");

  const { rows: nodes } = await client.query(`
    SELECT id, nome, ST_Y(posizione::geometry) AS lat, ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali
    WHERE id = ANY($1::bigint[]) AND attivo = TRUE`, [NODI]);
  assert.equal(nodes.length, 3, 'I nodi 8,5,7 devono essere attivi');
  const byId = new Map(nodes.map(n => [Number(n.id), {
    ...n, lat: Number(n.lat), lon: Number(n.lon)
  }]));
  const outward = await leg(byId.get(8), byId.get(5));
  const inward = await leg(byId.get(7), byId.get(5));
  assert.ok(Number.isFinite(outward?.seconds) && outward.seconds > 0, 'Routing 8->5 non disponibile');
  assert.ok(Number.isFinite(inward?.seconds) && inward.seconds > 0, 'Routing 7->5 non disponibile');
  // Un cliente reale esistente nel DB di staging; nessuna modifica alla sua anagrafica.
  const { rows: clienti } = await client.query(`
    SELECT id FROM public.utente WHERE id > 0 ORDER BY id LIMIT 1`);
  assert.ok(clienti.length > 0, 'Fixture: nessun cliente valido nel database staging');
  const clienteId = Number(clienti[0].id);
  assert.ok(Number.isSafeInteger(clienteId) && clienteId > 0, 'Fixture: cliente_id non valido');
  const cases = [
    { a: 8, b: 5, at: day },
    { a: 5, b: 7, at: new Date(day.getTime() + Math.round(outward.seconds) * 1000) },
    { a: 8, b: 7, at: day },
    { a: 7, b: 5, at: secondStart },
    { a: 5, b: 8, at: new Date(secondStart.getTime() + Math.round(inward.seconds) * 1000) },
    { a: 7, b: 8, at: secondStart }
  ];
  for (const c of cases) {
    const a = byId.get(c.a), b = byId.get(c.b);
    const { rows } = await client.query(`
      INSERT INTO public.richieste_pop_bus
        (origine, destinazione, origine_nodo_territoriale_id,
         destinazione_nodo_territoriale_id, origine_address,
         destinazione_address, start_datetime, posti_richiesti,
         stato, classe, prezzo, cliente_id, payment_intent_id)
      VALUES
        (ST_SetSRID(ST_MakePoint($1,$2),4326),
         ST_SetSRID(ST_MakePoint($3,$4),4326),
         $5,$6,$7,$8,$9,1,'in_attesa','STANDARD',$10,$11,$12)
      RETURNING id`, [a.lon, a.lat, b.lon, b.lat, c.a, c.b,
      a.nome ?? `Nodo ${c.a}`, b.nome ?? `Nodo ${c.b}`, c.at, PREZZO_TEST,
      clienteId, `pi_test_turentu_e2e_${randomUUID()}`]);
    inserted.push(Number(rows[0].id));
  }
  console.log('[FIXTURE]', { clienteId, richieste: inserted, casi: cases.map(c => `${c.a}>${c.b} ${c.at.toISOString()}`) });

  const pixel = await eseguiPixelInTransazione({
    client, now: new Date(), maxRichieste: 100, maxDirettrici: 500,
    abilitaVariantiP1: true, bufferMinuti: 0
  });
  assert.equal(pixel.committed, false);
  assert.equal(pixel.richiesteEsaminate, 6,
    `Attese 6 richieste nel bootstrap, lette ${pixel.richiesteEsaminate}. Usare DB staging isolato.`);
  opportunityIds = unique((pixel.pubblicazioni ?? []).flatMap(p => p.opportunityIds ?? []));
  console.log('[PIXEL]', {
    richiesteEsaminate: pixel.richiesteEsaminate,
    direttriciPubblicate: pixel.direttriciPubblicate,
    opportunita: opportunityIds
  });
  assert.ok(opportunityIds.length > 0, 'Nessuna opportunita PIXEL pubblicata');
  assert.ok(opportunityIds.length <= 15, 'Superato limite opportunita del collaudo POPBUS');

  const { rows: associations } = await client.query(`
    SELECT o.id AS opportunita_id, por.richiesta_id
    FROM public.pixel_opportunita o
    JOIN public.pixel_opportunita_richieste por ON por.opportunita_id = o.id
    WHERE o.id = ANY($1::bigint[])`, [opportunityIds]);
  const associated = new Set(associations.map(r => Number(r.richiesta_id)));
  for (const id of inserted) {
    assert.ok(associated.has(id), `PIXEL non ha associato la richiesta sintetica ${id}`);
  }
  const opportunitiesWithFixture = unique(associations
    .filter(r => inserted.includes(Number(r.richiesta_id)))
    .map(r => r.opportunita_id));
  assert.ok(opportunitiesWithFixture.length >= 2,
    'Meno di due opportunita PIXEL contengono le richieste del fixture');

  console.log('[E2E] Diagnostica formazioni attiva con POPBUS_PIXEL_DIAGNOSTICA=1');
  const popbus = await collaudaPixelFirstInTransazione({
    client, now: Date.now(), opportunityIds: opportunitiesWithFixture
  });
  console.log('[POPBUS]', JSON.stringify(popbus, null, 2));
  assert.equal(popbus.offerte, 1,
    `Nessun ciclo attivabile: ${popbus.motivo ?? 'vedere diagnostica POPBUS'}`);
  activationId = Number(popbus.attivazioneId);
  offerId = Number(popbus.offertaId);
  assert.ok(Number.isSafeInteger(activationId) && activationId > 0, 'ID attivazione mancante');
  assert.ok(Number.isSafeInteger(offerId) && offerId > 0, 'ID offerta mancante');

  const act = await client.query('SELECT id FROM public.popbus_attivazioni WHERE id=$1', [activationId]);
  const off = await client.query('SELECT id, attivazione_id FROM public.offerte_autisti WHERE id=$1', [offerId]);
  const missions = await client.query(`
    SELECT id, ordine, pixel_opportunita_id
    FROM public.popbus_attivazione_missioni
    WHERE attivazione_id=$1 ORDER BY ordine`, [activationId]);
  assert.equal(act.rowCount, 1, 'Attivazione non presente nella transazione');
  assert.equal(off.rowCount, 1, 'Offerta non presente nella transazione');
  assert.equal(Number(off.rows[0].attivazione_id), activationId);
  assert.equal(missions.rowCount, 2, 'Il ciclo deve contenere esattamente due missioni');
  missionIds = missions.rows.map(r => Number(r.id));
  assert.equal(new Set(missions.rows.map(r => Number(r.pixel_opportunita_id))).size, 2,
    'Le due missioni devono provenire da opportunita distinte');
  assert.ok(missions.rows.every(r => opportunitiesWithFixture.includes(Number(r.pixel_opportunita_id))),
    'Missione proveniente da opportunita estranea al fixture');

  const mr = await client.query(`
    SELECT missione_id, richiesta_id FROM public.popbus_missione_richieste
    WHERE missione_id = ANY($1::bigint[])`, [missionIds]);
  const ar = await client.query(`
    SELECT richiesta_id, attiva FROM public.popbus_attivazione_richieste
    WHERE attivazione_id=$1`, [activationId]);
  assert.ok(mr.rowCount >= 2, 'Associazioni missione-richiesta insufficienti');
  assert.ok(ar.rowCount >= 2 && ar.rows.every(r => r.attiva === true),
    'Associazioni attivazione-richiesta mancanti o inattive');
  const missionRequestIds = unique(mr.rows.map(r => r.richiesta_id)).sort((a,b) => a-b);
  const activationRequestIds = unique(ar.rows.map(r => r.richiesta_id)).sort((a,b) => a-b);
  assert.deepEqual(missionRequestIds, activationRequestIds,
    'Richieste delle missioni e dell’attivazione differenti');
  assert.ok(activationRequestIds.every(id => inserted.includes(id)),
    'Attivazione include richieste estranee al fixture');
  console.log('[PASS INTERNO]', { activationId, offerId, missionIds, richiesteSelezionate: activationRequestIds });
} catch (error) {
  failed = true;
  console.error('[FAIL]', error.stack ?? error.message);
} finally {
  if (client) {
    if (tx) {
      try {
        await client.query('ROLLBACK');
        console.log('[ROLLBACK] Eseguito');
      } catch (error) {
        failed = true;
        console.error('[ROLLBACK FALLITO]', error.stack ?? error.message);
      }
    }
    client.release();
  }
  try {
    if (inserted.length) {
      const r = await pool.query('SELECT id FROM public.richieste_pop_bus WHERE id = ANY($1::integer[])', [inserted]);
      assert.equal(r.rowCount, 0, 'Richieste sintetiche rimaste dopo rollback');
    }
    if (opportunityIds.length) {
      const r = await pool.query('SELECT id FROM public.pixel_opportunita WHERE id = ANY($1::bigint[])', [opportunityIds]);
      assert.equal(r.rowCount, 0, 'Opportunita PIXEL rimaste dopo rollback');
    }
    if (activationId) {
      const r = await pool.query('SELECT id FROM public.popbus_attivazioni WHERE id=$1', [activationId]);
      assert.equal(r.rowCount, 0, 'Attivazione POPBUS rimasta dopo rollback');
    }
    if (offerId) {
      const r = await pool.query('SELECT id FROM public.offerte_autisti WHERE id=$1', [offerId]);
      assert.equal(r.rowCount, 0, 'Offerta POPBUS rimasta dopo rollback');
    }
    if (missionIds.length) {
      const r = await pool.query('SELECT id FROM public.popbus_attivazione_missioni WHERE id = ANY($1::bigint[])', [missionIds]);
      assert.equal(r.rowCount, 0, 'Missioni POPBUS rimaste dopo rollback');
      const links = await pool.query('SELECT missione_id FROM public.popbus_missione_richieste WHERE missione_id = ANY($1::bigint[])', [missionIds]);
      assert.equal(links.rowCount, 0, 'Associazioni missione-richiesta rimaste dopo rollback');
    }
    if (activationId) {
      const links = await pool.query('SELECT richiesta_id FROM public.popbus_attivazione_richieste WHERE attivazione_id=$1', [activationId]);
      assert.equal(links.rowCount, 0, 'Associazioni attivazione-richiesta rimaste dopo rollback');
    }
    console.log('[ROLLBACK VERIFICATO] Nessuna riga sintetica residua');
  } catch (error) {
    failed = true;
    console.error('[VERIFICA ROLLBACK FALLITA]', error.stack ?? error.message);
  } finally {
    await pool.end();
  }
}
if (!failed) console.log('TEST E2E TERRITORIALE: PASS');
else process.exitCode = 1;
