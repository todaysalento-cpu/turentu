/**
 * TURENTU — Test A/R con due operatori NCC, SOLO DATABASE DI COLLAUDO.
 * Inserimenti temporanei nella stessa transazione; ROLLBACK finale obbligatorio.
 * Non testa la persistenza tra transazioni distinte o la concorrenza.
 * Salvare come test-ar-ncc-multioperatore.js nella radice project-root.
 */
import { randomUUID } from 'node:crypto';
import { pool } from './db/db.js';
import { accettaTrattaARAtomica } from './services/booking/ar-atomic-acceptance.service.js';
import { verificaCoppiaAR } from './services/booking/ar-acceptance.service.js';

const groupId = randomUUID();
const clienteId = 1;
const expiresAt = new Date(Date.now() + 30 * 60_000);
const legs = [
  {
    tratta: 'andata', veicoloId: 357, operatoreId: 2,
    start: '2026-11-10T09:00:00.000Z', minutes: 60,
    from: { lat: 39.9067, lon: 18.3644 },
    to: { lat: 40.6576, lon: 17.9465 }
  },
  {
    tratta: 'ritorno', veicoloId: 374, operatoreId: 452,
    start: '2026-11-10T14:00:00.000Z', minutes: 60,
    from: { lat: 40.6576, lon: 17.9465 },
    to: { lat: 39.9067, lon: 18.3644 }
  }
];

let client;
let transactionOpen = false;
let pendingIds = [];
let passed = false;
let rollbackOk = false;
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

  const prima = await verificaCoppiaAR(client, groupId);
  const primaCount = await client.query(
    'SELECT count(*)::int AS n FROM ar_accettazioni WHERE ar_group_id = $1',
    [groupId]
  );
  console.log('PRIMA', { completa: prima.completa, accettazioni: primaCount.rows[0].n });

  const a = await accettaTrattaARAtomica({
    pendingId: pendingIds[0], operatoreId: 2, client
  });
  const intermedia = await verificaCoppiaAR(client, groupId);
  const intermediaRows = await client.query(
    'SELECT pending_id, veicolo_id, stato FROM ar_accettazioni WHERE ar_group_id = $1 ORDER BY pending_id',
    [groupId]
  );
  console.log('DOPO_OPERATORE_2', { accettazione: a, completa: intermedia.completa, righe: intermediaRows.rows });

  const b = await accettaTrattaARAtomica({
    pendingId: pendingIds[1], operatoreId: 452, client
  });
  const finale = await verificaCoppiaAR(client, groupId);
  const finaleRows = await client.query(
    'SELECT pending_id, veicolo_id, stato FROM ar_accettazioni WHERE ar_group_id = $1 ORDER BY pending_id',
    [groupId]
  );
  console.log('DOPO_OPERATORE_452', { accettazione: b, completa: finale.completa, righe: finaleRows.rows });

  const groupState = await client.query('SELECT stato FROM ar_gruppi WHERE id = $1', [groupId]);
  const firstOnly = intermediaRows.rows.length === 1 &&
    Number(intermediaRows.rows[0].pending_id) === pendingIds[0] &&
    Number(intermediaRows.rows[0].veicolo_id) === 357;
  const both = finaleRows.rows.length === 2 &&
    finaleRows.rows.every((r, i) => Number(r.pending_id) === pendingIds[i] &&
      Number(r.veicolo_id) === legs[i].veicoloId && r.stato === 'provvisoria');

  passed = prima.completa === false && primaCount.rows[0].n === 0 &&
    a.soloAccettazioneProvvisoria === true &&
    intermedia.completa === false && firstOnly &&
    b.soloAccettazioneProvvisoria === true &&
    finale.completa === true && both &&
    groupState.rows[0]?.stato === 'autorizzato';
  console.log('ESITO_LOGICO', passed ? 'PASS' : 'FAIL');
} catch (error) {
  console.error('TEST_ERROR', error.code || error.message);
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  if (client && transactionOpen) {
    try {
      await client.query('ROLLBACK');
      rollbackOk = true;
      console.log('ROLLBACK_ESEGUITO');
    } catch (error) {
      console.error('ROLLBACK_ERROR', error);
      process.exitCode = 1;
    }
  }
  if (client) client.release();
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM ar_gruppi WHERE id=$1) AS gruppi,
         (SELECT count(*)::int FROM pending WHERE ar_group_id=$1) AS pending,
         (SELECT count(*)::int FROM ar_accettazioni WHERE ar_group_id=$1) AS accettazioni`,
      [groupId]
    );
    console.log('VERIFICA_POST_ROLLBACK', rows[0]);
    const empty = Object.values(rows[0]).every(x => x === 0);
    const ok = passed && rollbackOk && empty && !process.exitCode;
    console.log('ESITO_FINALE', ok ? 'PASS' : 'FAIL');
    if (!ok) process.exitCode = 1;
  } catch (error) {
    console.error('VERIFICA_POST_ROLLBACK_ERROR', error);
    process.exitCode = 1;
  }
  await pool.end();
}
