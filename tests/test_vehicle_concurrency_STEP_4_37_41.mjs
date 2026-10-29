/**
 * TURENTU STEP 4.37.41 — Concorrenza end-to-end su tabelle isolate.
 * Eseguire: node --env-file=.env tests\test_vehicle_concurrency_STEP_4_37_41.mjs
 * NON chiama endpoint Turentu e NON modifica le tabelle applicative.
 * Richiede CREATE TABLE/DROP TABLE nello schema public.
 */
import { randomBytes } from 'node:crypto';
import { pool } from '../db/db.js';

const suffix = randomBytes(6).toString('hex');
const vehicles = `public.turentu_test_vehicles_${suffix}`;
const jobs = `public.turentu_test_jobs_${suffix}`;
const start = new Date('2035-01-01T12:00:00Z');
const end = new Date('2035-01-01T13:00:00Z');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
function check(condition, description) {
  if (!condition) throw new Error(`FAIL ${description}`);
  console.log(`PASS ${++passed} - ${description}`);
}
async function begin(c) { await c.query('BEGIN ISOLATION LEVEL READ COMMITTED'); }
async function rollback(c) { await c.query('ROLLBACK').catch(() => {}); }
async function lock(c, id) {
  const r = await c.query(`SELECT id FROM ${vehicles} WHERE id=$1 FOR UPDATE`, [id]);
  if (r.rowCount !== 1) throw new Error('TEST_VEHICLE_NOT_FOUND');
}
async function overlapping(c, id) {
  const r = await c.query(
    `SELECT id FROM ${jobs} WHERE vehicle_id=$1 AND start_at < $3 AND end_at > $2`,
    [id, start, end]
  );
  return r.rows;
}
async function insertJob(c, id) {
  await c.query(
    `INSERT INTO ${jobs}(vehicle_id,start_at,end_at) VALUES ($1,$2,$3)`,
    [id,start,end]
  );
}
let admin, a, b;
try {
  admin = await pool.connect();
  a = await pool.connect();
  b = await pool.connect();
  await admin.query(`CREATE TABLE ${vehicles} (
    id integer PRIMARY KEY, operator_id integer NOT NULL
  )`);
  await admin.query(`CREATE TABLE ${jobs} (
    id bigserial PRIMARY KEY, vehicle_id integer NOT NULL REFERENCES ${vehicles}(id),
    start_at timestamptz NOT NULL, end_at timestamptz NOT NULL
  )`);
  await admin.query(`INSERT INTO ${vehicles}(id,operator_id) VALUES (347,2),(352,2)`);
  console.log('Tabelle isolate create:', vehicles, jobs);

  // SCENARIO 1: A conferma; B deve aspettare e poi rileggere il conflitto.
  await begin(a);
  await lock(a,347);
  await insertJob(a,347);
  await begin(b);
  let bAcquired = false;
  const waitB = lock(b,347).then(() => { bAcquired = true; });
  await pause(250);
  check(!bAcquired, 'B attende il lock sul medesimo veicolo');
  await a.query('COMMIT');
  await waitB;
  check(bAcquired, 'B acquisisce il lock dopo COMMIT di A');
  check((await overlapping(b,347)).length === 1,
    'B rilegge la missione confermata e rileva sovrapposizione');
  await rollback(b);
  check((await overlapping(admin,347)).length === 1,
    'Una sola missione confermata per il veicolo 347');

  // SCENARIO 2: A annulla; B deve trovare libera la stessa fascia,
  // dopo aver ottenuto il lock e riletto.
  await admin.query(`DELETE FROM ${jobs}`);
  await begin(a);
  await lock(a,347);
  await insertJob(a,347);
  await begin(b);
  let bAfterRollback = false;
  const waitRollback = lock(b,347).then(() => { bAfterRollback = true; });
  await pause(250);
  check(!bAfterRollback, 'B attende mentre A non ha confermato');
  await rollback(a);
  await waitRollback;
  check((await overlapping(b,347)).length === 0,
    'B non vede la missione annullata da A');
  await insertJob(b,347);
  await b.query('COMMIT');
  check((await overlapping(admin,347)).length === 1,
    'B puo confermare dopo ROLLBACK di A');

  // SCENARIO 3: due veicoli dello stesso operatore non si bloccano tra loro.
  await admin.query(`DELETE FROM ${jobs}`);
  await begin(a);
  await lock(a,347);
  await begin(b);
  await b.query(`SET LOCAL lock_timeout = '1000ms'`);
  await lock(b,352);
  check(true, 'Veicoli 347 e 352 dello stesso operatore: lock indipendenti');
  await insertJob(a,347);
  await insertJob(b,352);
  await a.query('COMMIT');
  await b.query('COMMIT');
  const total = await admin.query(`SELECT COUNT(*)::integer AS n FROM ${jobs}`);
  check(total.rows[0].n === 2, 'Due missioni simultanee su veicoli diversi confermate');
  console.log(`RISULTATO: ${passed}/10 test superati`);
} catch (e) {
  console.error('TEST FALLITO:', e.code ?? '', e.message);
  process.exitCode = 1;
} finally {
  if (a) await rollback(a);
  if (b) await rollback(b);
  a?.release();
  b?.release();
  if (admin) {
    try {
      await admin.query(`DROP TABLE IF EXISTS ${jobs}`);
      await admin.query(`DROP TABLE IF EXISTS ${vehicles}`);
      console.log('Tabelle isolate eliminate');
    } catch (e) {
      console.error('PULIZIA FALLITA:', e.message, 'Tabelle:', jobs, vehicles);
      process.exitCode = 1;
    }
    admin.release();
  }
  await pool.end();
}
