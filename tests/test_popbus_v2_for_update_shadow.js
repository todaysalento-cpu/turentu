/**
 * POPBUS V2 - test dinamico FOR UPDATE / doppia prenotazione SHADOW.
 * Esegue DDL SOLO su una tabella di test dedicata public.popbus_shadow_lock_test_<pid>_<random>.
 * Non legge e non modifica tabelle operative. La tabella di test viene eliminata nel finally.
 * Requisiti: DATABASE_URL, pacchetto pg. Avviare da project-root.
 */
import pg from 'pg';
import { randomBytes } from 'node:crypto';

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL non impostata. Nessuna connessione tentata.');
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 10000 });
  const table = `public.popbus_shadow_lock_test_${process.pid}_${randomBytes(5).toString('hex')}`;
  let a, b, admin, created = false, passed = 0;
  const assert = (ok, label) => { if (!ok) throw new Error(`FAIL: ${label}`); console.log(`✅ ${String(++passed).padStart(2,'0')} — ${label}`); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rollback = async c => { if (c) { try { await c.query('ROLLBACK'); } catch {} } };
  const checkSafeTarget = async c => {
    const r = await c.query('SELECT current_database() AS db, current_user AS usr');
    console.log(`🔌 Database: ${r.rows[0].db} — test SHADOW con tabella dedicata`);
  };
  try {
    admin = await pool.connect(); a = await pool.connect(); b = await pool.connect();
    await checkSafeTarget(admin);
    await admin.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, stato text NOT NULL, prenotato_da text)`);
    created = true;
    await admin.query(`INSERT INTO ${table}(id,stato) VALUES (1,'in_attesa'),(2,'in_attesa')`);
    assert(true, 'Tabella SHADOW dedicata creata (nessuna tabella Turentu toccata)');

    // La seconda transazione non puo' bloccare una riga gia' bloccata.
    await a.query('BEGIN');
    await a.query(`SELECT id FROM ${table} WHERE id=1 FOR UPDATE`);
    await b.query('BEGIN');
    const skip = await b.query(`SELECT id FROM ${table} WHERE id=1 FOR UPDATE SKIP LOCKED`);
    assert(skip.rowCount === 0, 'FOR UPDATE SKIP LOCKED evita la riga bloccata');
    const free = await b.query(`SELECT id FROM ${table} WHERE id=2 FOR UPDATE SKIP LOCKED`);
    assert(free.rowCount === 1, 'Una richiesta distinta resta prenotabile');
    await rollback(b);

    // Timeout sul tentativo concorrente, senza attesa infinita.
    await b.query('BEGIN');
    await b.query("SET LOCAL lock_timeout = '250ms'");
    let timeout = false;
    try { await b.query(`SELECT id FROM ${table} WHERE id=1 FOR UPDATE`); }
    catch (e) { timeout = e.code === '55P03'; }
    assert(timeout, 'FOR UPDATE concorrente viene bloccato (lock_timeout 55P03)');
    await rollback(b);
    await a.query('COMMIT');

    // Gara vera: B aspetta il commit di A e poi rivalida lo stato.
    await admin.query(`UPDATE ${table} SET stato='in_attesa',prenotato_da=NULL WHERE id=1`);
    await a.query('BEGIN');
    const first = await a.query(`SELECT stato FROM ${table} WHERE id=1 FOR UPDATE`);
    assert(first.rows[0].stato === 'in_attesa', 'Prima transazione vede richiesta libera sotto lock');
    let started;
    const bStarted = new Promise(resolve => { started = resolve; });
    const secondAttempt = (async () => {
      await b.query('BEGIN');
      await b.query("SET LOCAL lock_timeout = '5000ms'");
      started();
      const rows = await b.query(`SELECT stato FROM ${table} WHERE id=1 FOR UPDATE`);
      if (rows.rows[0].stato === 'in_attesa') {
        await b.query(`UPDATE ${table} SET stato='in_lavorazione', prenotato_da='B' WHERE id=1`);
        await b.query('COMMIT');
        return 'B_WIN';
      }
      await b.query('ROLLBACK');
      return 'B_REJECT';
    })();
    await bStarted;
    await sleep(150);
    await a.query(`UPDATE ${table} SET stato='in_lavorazione', prenotato_da='A' WHERE id=1`);
    await a.query('COMMIT');
    const secondResult = await secondAttempt;
    assert(secondResult === 'B_REJECT', 'Seconda prenotazione rifiutata dopo rivalidazione dello stato');
    const winner = await admin.query(`SELECT stato, prenotato_da FROM ${table} WHERE id=1`);
    assert(winner.rows[0].stato === 'in_lavorazione' && winner.rows[0].prenotato_da === 'A', 'Un solo assegnatario persistente');

    // Atomicita': cambio stato e inserimento simulato, poi rollback.
    await admin.query(`UPDATE ${table} SET stato='in_attesa',prenotato_da=NULL WHERE id=2`);
    await a.query('BEGIN');
    await a.query(`SELECT id FROM ${table} WHERE id=2 FOR UPDATE`);
    await a.query(`UPDATE ${table} SET stato='in_lavorazione', prenotato_da='ERRORE' WHERE id=2`);
    await a.query('ROLLBACK');
    const restored = await admin.query(`SELECT stato, prenotato_da FROM ${table} WHERE id=2`);
    assert(restored.rows[0].stato === 'in_attesa' && restored.rows[0].prenotato_da === null, 'ROLLBACK ripristina integralmente la richiesta');

    console.log(`\n${passed}/${passed} controlli dinamici FOR UPDATE superati.`);
    console.log('SHADOW: nessuna scrittura su richieste_pop_bus, corse, offerte_autisti o attivazioni.');
    console.log('NON verifica ancora il worker reale, i trigger operativi o il comportamento end-to-end.');
  } catch (err) {
    console.error('❌ TEST FALLITO:', err.message);
    process.exitCode = 1;
  } finally {
    await Promise.all([rollback(a), rollback(b)]);
    if (created && admin) {
      try { await admin.query(`DROP TABLE IF EXISTS ${table}`); console.log('🧹 Tabella SHADOW eliminata.'); }
      catch (e) { console.error(`⚠️ PULIZIA FALLITA: eliminare manualmente ${table}. Dettaglio: ${e.message}`); process.exitCode = 1; }
    }
    for (const c of [a,b,admin]) if (c) c.release();
    await pool.end();
  }
}
