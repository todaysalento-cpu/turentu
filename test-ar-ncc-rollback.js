/**
 * TURENTU — collaudo A/R NCC con transazione esterna, senza Stripe.
 * Copiare nella radice project-root ed eseguire: node test-ar-ncc-rollback.js
 * Non usare su database di produzione senza autorizzazione esplicita.
 */
import { randomUUID } from 'node:crypto';
import { pool } from './db/db.js';
import { coordinaAccettazioneProvvisoriaNccAR } from './services/booking/ar-ncc-acceptance-coordinator.service.js';

const groupId = randomUUID();
const clienteId = 1;
const operatoreId = 2;
const expiresAt = new Date(Date.now() + 30 * 60_000);
const legs = [
  {
    tratta: 'andata', veicoloId: 357,
    start: '2026-11-10T09:00:00.000Z', minutes: 60,
    from: { lat: 39.9067, lon: 18.3644 },
    to: { lat: 40.6576, lon: 17.9465 }
  },
  {
    tratta: 'ritorno', veicoloId: 358,
    start: '2026-11-10T14:00:00.000Z', minutes: 60,
    from: { lat: 40.6576, lon: 17.9465 },
    to: { lat: 39.9067, lon: 18.3644 }
  }
];

let client;
let transactionOpen = false;
let pendingIds = [];
let passed = false;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  transactionOpen = true;
  await client.query("SET LOCAL lock_timeout = '2000ms'");
  await client.query("SET LOCAL statement_timeout = '15000ms'");

  await client.query(
    `INSERT INTO ar_gruppi (id, cliente_id, stato, expires_at)
     VALUES ($1, $2, 'autorizzato', $3)`,
    [groupId, clienteId, expiresAt]
  );

  for (const leg of legs) {
    const { rows } = await client.query(
      `INSERT INTO pending
        (veicolo_id, cliente_id, start_datetime, durata, posti_richiesti,
         tipo_corsa, expires_at, stato, origine, destinazione,
         ar_group_id, ar_tratta, ar_vincolata)
       VALUES
        ($1, $2, $3::timestamptz, ($4::integer * INTERVAL '1 minute'), 1,
         'privata', $5, 'pending',
         ST_SetSRID(ST_MakePoint($6, $7), 4326),
         ST_SetSRID(ST_MakePoint($8, $9), 4326),
         $10, $11, TRUE)
       RETURNING id`,
      [leg.veicoloId, clienteId, leg.start, leg.minutes, expiresAt,
       leg.from.lon, leg.from.lat, leg.to.lon, leg.to.lat,
       groupId, leg.tratta]
    );
    pendingIds.push(rows[0].id);
  }

  console.log('DATI_TEMPORANEI', { groupId, pendingIds });
  const result = await coordinaAccettazioneProvvisoriaNccAR({
    arGroupId: groupId, operatoreId, rollbackOnly: true, client
  });
  console.dir(result, { depth: 5 });

  const { rows: afterSavepoint } = await client.query(
    'SELECT count(*)::int AS n FROM ar_accettazioni WHERE ar_group_id = $1',
    [groupId]
  );
  const ids = result.tratteAccettate.map(x => Number(x.pendingId)).sort((a,b) => a-b);
  const expected = [...pendingIds].sort((a,b) => a-b);
  passed = result.rollbackOnly === true &&
    result.stessoOperatore === true &&
    result.coppiaCompletaNelTest === true &&
    ids.length === 2 && ids.every((x,i) => x === expected[i]) &&
    afterSavepoint[0].n === 0 &&
    result.confermata === false &&
    result.catturaStripeAbilitata === false;
  console.log('CHECK_ACCETTAZIONI_DOPO_SAVEPOINT', afterSavepoint[0].n);
  console.log('ESITO_LOGICO', passed ? 'PASS' : 'FAIL');
} catch (error) {
  console.error('TEST_ERROR', error.code || error.message);
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  if (client && transactionOpen) {
    try { await client.query('ROLLBACK'); console.log('ROLLBACK_ESEGUITO'); }
    catch (error) { console.error('ROLLBACK_ERROR', error); process.exitCode = 1; }
  }
  if (client) client.release();
  try {
    const { rows: persisted } = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM ar_gruppi WHERE id=$1) AS gruppi,
        (SELECT count(*)::int FROM pending WHERE ar_group_id=$1) AS pending,
        (SELECT count(*)::int FROM ar_accettazioni WHERE ar_group_id=$1) AS accettazioni`,
      [groupId]
    );
    console.log('VERIFICA_POST_ROLLBACK', persisted[0]);
    const empty = Object.values(persisted[0]).every(x => x === 0);
    console.log('ESITO_FINALE', passed && empty && !process.exitCode ? 'PASS' : 'FAIL');
    if (!empty || !passed) process.exitCode = 1;
  } catch (error) {
    console.error('VERIFICA_POST_ROLLBACK_ERROR', error);
    process.exitCode = 1;
  }
  await pool.end();
}
