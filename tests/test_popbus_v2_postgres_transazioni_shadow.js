/**
 * TURENTU POPBUS V2 — PostgreSQL dynamic transaction SHADOW test
 * Run: node tests/test_popbus_v2_postgres_transazioni_shadow.js
 * Requires DATABASE_URL environment variable and installed 'pg' package.
 * NO production table writes, NO worker import, NO Stripe, NO sockets.
 * Uses TEMP tables with ON COMMIT PRESERVE ROWS (session-private).
 */
import assert from 'node:assert/strict';
import pg from 'pg';

const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('❌ DATABASE_URL non impostata. Nessuna connessione tentata.');
  process.exitCode = 1;
} else {
  const opts = { connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 12000, query_timeout: 12000, application_name: 'turentu_popbus_v2_shadow_test' };
  const a = new Client(opts);
  const b = new Client(opts);
  let passed = 0;
  const ok = (label) => { passed++; console.log(`✅ ${String(passed).padStart(2, '0')} — ${label}`); };
  async function rollbackQuiet(client) { try { await client.query('ROLLBACK'); } catch {} }
  try {
    await a.connect(); await b.connect();
    const identity = await a.query('SELECT current_database() AS db, pg_backend_pid() AS pid');
    console.log(`🔌 Connesso al database ${identity.rows[0].db} — test isolato, nessuna tabella operativa modificata`);

    // TEMP tables exist only in their creating connection.
    await a.query('CREATE TEMP TABLE popbus_shadow_probe (id int PRIMARY KEY, valore int NOT NULL) ON COMMIT PRESERVE ROWS');
    await a.query('INSERT INTO popbus_shadow_probe VALUES (1, 100)');
    const tempVisible = await a.query('SELECT valore FROM popbus_shadow_probe WHERE id=1');
    assert.equal(tempVisible.rows[0].valore, 100);
    ok('Tabella temporanea privata creata');

    await a.query('BEGIN');
    await a.query('UPDATE popbus_shadow_probe SET valore=200 WHERE id=1');
    const beforeRollback = await a.query('SELECT valore FROM popbus_shadow_probe WHERE id=1');
    assert.equal(beforeRollback.rows[0].valore, 200);
    await a.query('ROLLBACK');
    const afterRollback = await a.query('SELECT valore FROM popbus_shadow_probe WHERE id=1');
    assert.equal(afterRollback.rows[0].valore, 100);
    ok('ROLLBACK annulla aggiornamenti reali PostgreSQL');

    await a.query('BEGIN');
    await a.query('UPDATE popbus_shadow_probe SET valore=300 WHERE id=1');
    await a.query('SAVEPOINT popbus_shadow_sp');
    await a.query('UPDATE popbus_shadow_probe SET valore=400 WHERE id=1');
    await a.query('ROLLBACK TO SAVEPOINT popbus_shadow_sp');
    const savepointValue = await a.query('SELECT valore FROM popbus_shadow_probe WHERE id=1');
    assert.equal(savepointValue.rows[0].valore, 300);
    await a.query('ROLLBACK');
    ok('SAVEPOINT e rollback parziale funzionano');

    // Advisory lock is independent of data rows and uses a distinct key
    // from the production worker's (734021,1).
    const lockKey1 = 2147483000;
    const lockKey2 = 1729;
    await a.query('BEGIN');
    await a.query('SELECT pg_advisory_xact_lock($1::int,$2::int)', [lockKey1, lockKey2]);
    const blocked = await b.query('SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS acquired', [lockKey1, lockKey2]);
    assert.equal(blocked.rows[0].acquired, false);
    ok('Seconda connessione non acquisisce advisory lock occupato');
    await a.query('ROLLBACK');
    const released = await b.query('SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS acquired', [lockKey1, lockKey2]);
    assert.equal(released.rows[0].acquired, true);
    ok('Advisory lock transazionale liberato dal ROLLBACK');

    // To test row locks across sessions, use a dedicated ordinary table? No:
    // that would write production schema. Instead use pg_class catalog rows
    // via SELECT FOR UPDATE is prohibited on system catalogs. We therefore
    // deliberately do not claim row-lock race coverage in this safe stage.
    await a.query('BEGIN');
    await a.query('SELECT pg_advisory_xact_lock($1::int,$2::int)', [lockKey1, lockKey2]);
    await b.query('BEGIN');
    const secondBlocked = await b.query('SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS acquired', [lockKey1, lockKey2]);
    assert.equal(secondBlocked.rows[0].acquired, false);
    await b.query('ROLLBACK');
    await a.query('COMMIT');
    ok('Lock rimane esclusivo fino al COMMIT');

    const afterCommit = await b.query('SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS acquired', [lockKey1, lockKey2]);
    assert.equal(afterCommit.rows[0].acquired, true);
    ok('Lock liberato dopo COMMIT');

    const finalValue = await a.query('SELECT valore FROM popbus_shadow_probe WHERE id=1');
    assert.equal(finalValue.rows[0].valore, 100);
    ok('Nessuna modifica permanente ai dati del test');

    console.log(`\n${passed}/${passed} controlli dinamici PostgreSQL superati.`);
    console.log('SHADOW: solo TEMP TABLE, nessuna scrittura alle tabelle Turentu, nessuna attivazione.');
    console.log('NON verificati: FOR UPDATE tra sessioni, race sulle richieste reali, trigger, worker, Stripe e socket.');
  } catch (err) {
    console.error('❌ TEST FALLITO:', err.message);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([rollbackQuiet(a), rollbackQuiet(b)]);
    await Promise.allSettled([a.end(), b.end()]);
  }
}
