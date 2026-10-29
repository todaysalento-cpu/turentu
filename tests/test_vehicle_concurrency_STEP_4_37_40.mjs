/**
 * TURENTU - STEP 4.37.40
 * Test PostgreSQL con due connessioni: visibilita' dopo COMMIT / ROLLBACK.
 * Eseguire su database autorizzato al collaudo.
 * Crea una tabella dedicata nello schema corrente e la elimina nel finally.
 * Non tocca tabelle applicative. Richiede privilegi CREATE TABLE.
 * Esecuzione: copiare in tests/test_vehicle_concurrency_STEP_4_37_40.mjs
 * node --env-file=.env tests/test_vehicle_concurrency_STEP_4_37_40.mjs
 */
import { pool } from '../db/db.js';

const table = 'turentu_test_vehicle_commitments_43740';
const ident = `"${table}"`;
let admin, a, b;
let passed = 0;
let created = false;
function check(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`PASS ${passed} - ${label}`);
}
async function rollback(client) {
  if (client) await client.query('ROLLBACK').catch(() => {});
}
async function readCount(client) {
  const { rows } = await client.query(`SELECT count(*)::integer AS n FROM ${ident} WHERE vehicle_id = 347`);
  return rows[0].n;
}
try {
  admin = await pool.connect();
  a = await pool.connect();
  b = await pool.connect();
  // Abort rather than overwrite any preexisting test artifact.
  const exists = await admin.query('SELECT to_regclass($1) AS reg', [table]);
  if (exists.rows[0].reg) throw new Error(`Tabella ${table} gia' esistente: non viene modificata`);
  await admin.query(`CREATE TABLE ${ident} (id integer PRIMARY KEY, vehicle_id integer NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL)`);
  created = true;
  console.log('Tabella isolata creata');

  // Scenario A: B starts before A commits, but reads after lock release.
  await a.query('BEGIN');
  await b.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await a.query(`INSERT INTO ${ident} (id, vehicle_id, start_at, end_at) VALUES (1, 347, '2030-01-01T10:00:00Z', '2030-01-01T11:00:00Z')`);
  check(await readCount(b) === 0, 'B non vede una scrittura non confermata');
  await a.query('COMMIT');
  check(await readCount(b) === 1, 'B vede la missione dopo COMMIT in READ COMMITTED');
  const { rows: conflicts } = await b.query(`SELECT id FROM ${ident} WHERE vehicle_id=347 AND start_at < $1::timestamptz AND end_at > $2::timestamptz`, ['2030-01-01T10:45:00Z', '2030-01-01T10:15:00Z']);
  check(conflicts.length === 1, 'B rileva la sovrapposizione dopo COMMIT');
  await b.query('ROLLBACK');

  // Scenario B: A rolls back; B must not see the uncommitted mission.
  await a.query('BEGIN');
  await b.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await a.query(`INSERT INTO ${ident} (id, vehicle_id, start_at, end_at) VALUES (2, 347, '2030-01-02T10:00:00Z', '2030-01-02T11:00:00Z')`);
  check(await readCount(b) === 1, 'B non vede la seconda missione non confermata');
  await a.query('ROLLBACK');
  check(await readCount(b) === 1, 'B non vede la missione annullata');
  const { rows: absent } = await b.query(`SELECT id FROM ${ident} WHERE id=2`);
  check(absent.length === 0, 'Missione annullata assente dopo ROLLBACK');
  await b.query('ROLLBACK');

  console.log(`RISULTATO: ${passed}/6 test superati`);
} catch (error) {
  console.error('TEST NON SUPERATO:', error.code || '', error.message);
  process.exitCode = 1;
} finally {
  await rollback(a);
  await rollback(b);
  // Do not drop if this execution did not create the table.
  if (admin) {
    try {
      const { rows } = await admin.query('SELECT to_regclass($1) AS reg', [table]);
      if (rows[0].reg && created) {
        await admin.query(`DROP TABLE ${ident}`);
        console.log('Tabella di test eliminata');
      }
    } catch (e) { console.error('ATTENZIONE: verificare ed eliminare la tabella di test:', table, e.message); process.exitCode = 1; }
  }
  a?.release(); b?.release(); admin?.release();
  await pool.end();
}
