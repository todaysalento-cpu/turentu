// TURENTU POPBUS P0-E1 — PostgreSQL preflight, pool del backend
// Salva come tests/test_popbus_P0E1_preflight_pool.mjs
// Usa il pool esistente. Nessuna scrittura nelle tabelle applicative.
import { pool } from '../db/db.js';

const tables = [
  'veicolo', 'disponibilita_veicolo', 'richieste_pop_bus',
  'popbus_attivazioni', 'popbus_attivazione_missioni',
  'popbus_missione_richieste', 'popbus_attivazione_richieste',
  'offerte_autisti', 'corse', 'prenotazioni', 'pagamenti',
  'direttrici_virtuali', 'segmenti'
];
let pass = 0, fail = 0;
function check(ok, description) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${description}`);
  ok ? pass++ : fail++;
}

let a, b;
try {
  console.log('=== TURENTU POPBUS P0-E1 / PREFLIGHT POSTGRESQL REALE ===');
  a = await pool.connect();
  b = await pool.connect();
  const info = await a.query('SELECT current_database() AS db, current_user AS usr, version() AS version');
  console.log('Connessione:', info.rows[0].db, '| Utente:', info.rows[0].usr);
  check(true, 'Connessione PostgreSQL tramite pool del backend');
  const schema = await a.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`, [tables]);
  const found = new Set(schema.rows.map(x => x.table_name));
  for (const t of tables) check(found.has(t), `Tabella public.${t}`);

  await a.query('BEGIN');
  try {
    await a.query('CREATE TEMP TABLE popbus_p0e1_probe (id integer PRIMARY KEY, valore text) ON COMMIT PRESERVE ROWS');
    await a.query("INSERT INTO popbus_p0e1_probe VALUES (1, 'prima')");
    await a.query('SAVEPOINT prova_rollback');
    await a.query("INSERT INTO popbus_p0e1_probe VALUES (2, 'da_annullare')");
    await a.query('ROLLBACK TO SAVEPOINT prova_rollback');
    const r = await a.query('SELECT COUNT(*)::int AS n FROM popbus_p0e1_probe');
    check(r.rows[0].n === 1, 'ROLLBACK TO SAVEPOINT elimina inserimento temporaneo');
    await a.query('ROLLBACK');
    const r2 = await a.query("SELECT to_regclass('pg_temp.popbus_p0e1_probe') AS t");
    check(r2.rows[0].t === null, 'ROLLBACK elimina tabella temporanea creata nella transazione');
  } catch (e) {
    await a.query('ROLLBACK').catch(() => {});
    throw e;
  }

  const pa = await a.query('SELECT pg_backend_pid() AS pid');
  const pb = await b.query('SELECT pg_backend_pid() AS pid');
  check(pa.rows[0].pid !== pb.rows[0].pid, 'Due connessioni PostgreSQL indipendenti');

  // Chiave riservata esclusivamente a questo test; non usa il lock POPBUS operativo.
  const lock1 = 724918, lock2 = 91037;
  await a.query('BEGIN');
  try {
    await a.query('SELECT pg_advisory_xact_lock($1, $2)', [lock1, lock2]);
    const denied = await b.query('SELECT pg_try_advisory_xact_lock($1, $2) AS acquired', [lock1, lock2]);
    // pg_try_advisory_xact_lock fuori da una transazione esplicita rilascia subito il lock.
    check(denied.rows[0].acquired === false, 'Lock transazionale impedisce accesso concorrente');
    await a.query('COMMIT');
    const allowed = await b.query('SELECT pg_try_advisory_xact_lock($1, $2) AS acquired', [lock1, lock2]);
    check(allowed.rows[0].acquired === true, 'Lock disponibile dopo COMMIT');
  } catch (e) {
    await a.query('ROLLBACK').catch(() => {});
    throw e;
  }
} catch (e) {
  fail++;
  console.error('ERRORE PREFLIGHT:', e.message);
} finally {
  if (a) a.release();
  if (b) b.release();
  await pool.end();
}
console.log(`ESITO: ${pass} PASS, ${fail} FAIL. Nessuna scrittura nelle tabelle applicative; nessuna chiamata Stripe.`);
if (fail) process.exitCode = 1;
