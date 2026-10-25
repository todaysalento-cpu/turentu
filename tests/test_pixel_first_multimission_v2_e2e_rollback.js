// TURENTU — PIXEL FIRST multimission V2, PostgreSQL real, ROLLBACK ONLY.
// Execute manually from project root: node --env-file=.env tests/test_pixel_first_multimission_v2_e2e_rollback.js
// This test performs temporary UPDATE/INSERT and routing calls; use only with authorization.
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';

const ensure = (condition, message) => assert.ok(condition, message);
const number = value => Number(value);
let inspected = null;
let result = null;
let failed = false;

async function count(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return number(rows[0].n);
}

try {
  ensure(process.env.POPBUS_PIXEL_FIRST_MODE === 'ROLLBACK_ONLY',
    'Impostare POPBUS_PIXEL_FIRST_MODE=ROLLBACK_ONLY');
  ensure(process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED !== '1',
    'Rimuovere POPBUS_PIXEL_FIRST_LIVE_APPROVED=1 per il test');
  ensure(process.env.POPBUS_MULTIMISSION_ACCEPTANCE_TEST !== 'true',
    'Non eseguire con flag di acceptance LIVE abilitato');

  const db = await pool.query('SELECT current_database() AS name, pg_is_in_recovery() AS replica');
  console.log('[DB]', db.rows[0]);

  result = await processaPixelFirstMultimissione({
    pool,
    mode: 'ROLLBACK_ONLY',
    rollbackTestHook: async (client, candidate) => {
      const activationId = number(candidate.attivazioneId);
      const offerId = number(candidate.offertaId);
      const requestIds = candidate.richiestaIds.map(number);
      ensure(Number.isSafeInteger(activationId) && activationId > 0, 'ID attivazione non valido');
      ensure(Number.isSafeInteger(offerId) && offerId > 0, 'ID offerta non valido');
      ensure(requestIds.length > 0 && new Set(requestIds).size === requestIds.length,
        'Richieste assenti o duplicate');
      ensure(candidate.opportunitaIds.length === 2, 'Attese esattamente due opportunita');

      const activation = (await client.query(
        'SELECT id, veicolo_id, autista_id, stato, piano FROM popbus_attivazioni WHERE id=$1',
        [activationId])).rows[0];
      ensure(activation, 'Attivazione assente nella transazione');
      ensure(number(activation.veicolo_id) === number(candidate.veicoloId), 'Veicolo incoerente');
      ensure(number(activation.autista_id) === number(candidate.autistaId), 'Operatore incoerente');
      ensure(activation.stato === 'in_attesa_autista', 'Stato attivazione inatteso');
      const plan = typeof activation.piano === 'string' ? JSON.parse(activation.piano) : activation.piano;
      ensure(Array.isArray(plan?.missioni) && plan.missioni.length === 2,
        'Il piano persistito non contiene due missioni');
      const opportunityIds = plan.missioni.map(m => number(m.pixelOpportunitaId));
      ensure(opportunityIds.every((id, i) => id === number(candidate.opportunitaIds[i])),
        'Identita opportunita PIXEL incoerenti');
      ensure(plan.missioni.every(m => Number.isSafeInteger(number(m.pixelDirettriceId)) &&
        number(m.pixelDirettriceId) > 0 && Number.isSafeInteger(number(m.pixelVersione)) &&
        number(m.pixelVersione) > 0), 'Metadati PIXEL incompleti');

      const missionCount = await count(client,
        'SELECT COUNT(*)::int AS n FROM popbus_attivazione_missioni WHERE attivazione_id=$1',
        [activationId]);
      ensure(missionCount === 2, `Attese 2 missioni, trovate ${missionCount}`);
      const requestCount = await count(client,
        'SELECT COUNT(*)::int AS n FROM popbus_attivazione_richieste WHERE attivazione_id=$1 AND attiva=TRUE',
        [activationId]);
      ensure(requestCount === requestIds.length,
        `Richieste associate ${requestCount}, attese ${requestIds.length}`);
      const uniqueCount = await count(client,
        'SELECT COUNT(DISTINCT richiesta_id)::int AS n FROM popbus_attivazione_richieste WHERE attivazione_id=$1 AND attiva=TRUE',
        [activationId]);
      ensure(uniqueCount === requestIds.length, 'Richieste duplicate nelle associazioni');
      const inProgressCount = await count(client,
        `SELECT COUNT(*)::int AS n FROM richieste_pop_bus
         WHERE id=ANY($1::integer[]) AND stato='in_lavorazione'`, [requestIds]);
      ensure(inProgressCount === requestIds.length,
        'Stati temporanei delle richieste non coerenti');
      const offerCount = await count(client,
        `SELECT COUNT(*)::int AS n FROM offerte_autisti
         WHERE id=$1 AND attivazione_id=$2 AND stato='inviata'`,
        [offerId, activationId]);
      ensure(offerCount === 1, 'Offerta transazionale non trovata');

      inspected = { activationId, offerId, requestIds, missionCount,
        requestCount, opportunityIds, veicoloId: number(candidate.veicoloId) };
      console.log('PIXEL_FIRST_V2_INSIDE_TX_PASS', JSON.stringify(inspected));
    }
  });

  ensure(result?.modalita === 'ROLLBACK_ONLY' || result?.modo === 'ROLLBACK_ONLY',
    'Modalita restituita non ROLLBACK_ONLY');
  ensure(result?.persistita !== true, 'Il servizio ha dichiarato persistenza LIVE');
  if (!inspected) {
    console.log('PIXEL_FIRST_V2_NO_CYCLE', JSON.stringify(result, null, 2));
    throw new Error('Nessun ciclo ha raggiunto il rollbackTestHook: diagnostica selezione necessaria');
  }

  const after = await pool.connect();
  try {
    const activationCount = await count(after,
      'SELECT COUNT(*)::int AS n FROM popbus_attivazioni WHERE id=$1',
      [inspected.activationId]);
    const offerCount = await count(after,
      'SELECT COUNT(*)::int AS n FROM offerte_autisti WHERE id=$1',
      [inspected.offerId]);
    const missionCount = await count(after,
      'SELECT COUNT(*)::int AS n FROM popbus_attivazione_missioni WHERE attivazione_id=$1',
      [inspected.activationId]);
    const requestLinkCount = await count(after,
      'SELECT COUNT(*)::int AS n FROM popbus_attivazione_richieste WHERE attivazione_id=$1',
      [inspected.activationId]);
    const restored = await count(after,
      `SELECT COUNT(*)::int AS n FROM richieste_pop_bus
       WHERE id=ANY($1::integer[]) AND stato='in_attesa' AND corsa_id IS NULL`,
      [inspected.requestIds]);
    ensure(activationCount === 0, 'Attivazione presente dopo rollback');
    ensure(offerCount === 0, 'Offerta presente dopo rollback');
    ensure(missionCount === 0, 'Missioni presenti dopo rollback');
    ensure(requestLinkCount === 0, 'Associazioni presenti dopo rollback');
    ensure(restored === inspected.requestIds.length,
      'Non tutte le richieste sono tornate in attesa');
    console.log('PIXEL_FIRST_V2_POST_ROLLBACK_PASS', JSON.stringify({
      activationCount, offerCount, missionCount, requestLinkCount, restored
    }));
    console.log('PIXEL_FIRST_V2_E2E_ROLLBACK_PASS');
  } finally {
    after.release();
  }
} catch (error) {
  failed = true;
  console.error('PIXEL_FIRST_V2_E2E_ROLLBACK_FAIL:', error?.stack || error);
} finally {
  await pool.end();
  if (failed) process.exitCode = 1;
}
