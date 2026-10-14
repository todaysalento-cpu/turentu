/**
 * POPBUS V2 - AUDIT RIVALIDAZIONE DOPO ROUTING
 * READ ONLY: nessuna scrittura, nessun worker avviato.
 * Verifica lock, SQL di rivalidazione e scenari di snapshot obsoleto.
 * NON dimostra la race end-to-end tra due worker con COMMIT.
 * Eseguire: node --env-file=.env tests/test_popbus_v2_rivalidazione.js
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(here, '../services/popbus/v2/worker.js');
const worker = fs.readFileSync(workerPath, 'utf8');
const normalize = s => s.replace(/\s+/g, ' ').trim();
const fingerprint = r => JSON.stringify([
  r.start_node_id, r.end_node_id,
  new Date(r.start_datetime).toISOString(),
  r.posti_richiesti, String(r.prezzo), r.classe
]);
function expectStatic(re, label) {
  assert.match(worker, re, `Worker: manca ${label}`);
  console.log(`STATICO | ${label}: PASS`);
}
let a, b;
let txA = false, txB = false;
let failed = false;
try {
  console.log('=== POPBUS V2 | RIVALIDAZIONE POST-ROUTING | SOLA LETTURA ===');
  expectStatic(/pg_advisory_xact_lock\s*\(\s*734021\s*,\s*1\s*\)/, 'advisory lock');
  const locks = (worker.match(/pg_advisory_xact_lock\s*\(\s*734021\s*,\s*1\s*\)/g) || []).length;
  assert.ok(locks >= 2, 'Lock non trovato in entrambe le fasi');
  expectStatic(/FROM\s+richieste_pop_bus[\s\S]*?FOR\s+UPDATE/i, 'FOR UPDATE richieste');
  expectStatic(/r\.stato\s*!==\s*['"]in_attesa['"]/, 'controllo stato richiesta');
  expectStatic(/r\.corsa_id\s*!=\s*null/, 'controllo corsa_id');
  expectStatic(/fingerprint\s*\(\s*r\s*\)\s*!==/, 'confronto fingerprint');
  expectStatic(/FROM\s+popbus_attivazione_richieste[\s\S]*?richiesta_id\s*=\s*ANY\s*\(\s*\$1::int\[\]\s*\)[\s\S]*?AND\s+attiva/i, 'controllo prenotazione attiva');
  expectStatic(/FROM\s+veicolo[\s\S]*?FOR\s+UPDATE/i, 'FOR UPDATE veicolo');
  expectStatic(/conflittiVeicolo\s*\(\s*client\s*,\s*c\.vehicle\.id\s*,\s*c\.busyStart\s*,\s*c\.busyEnd\s*\)/, 'ricontrollo conflitti');

  a = await pool.connect(); b = await pool.connect();
  await a.query('BEGIN READ ONLY'); txA = true;
  await b.query('BEGIN READ ONLY'); txB = true;
  await a.query("SET LOCAL lock_timeout = '1500ms'");
  await b.query("SET LOCAL lock_timeout = '1500ms'");
  await a.query('SELECT pg_advisory_xact_lock(734021,1)');
  const denied = await b.query('SELECT pg_try_advisory_xact_lock(734021,1) AS ok');
  assert.equal(denied.rows[0].ok, false);
  console.log('CONCORRENZA | B non acquisisce lock mentre A lo detiene: PASS');
  await a.query('ROLLBACK'); txA = false;
  const acquired = await b.query('SELECT pg_try_advisory_xact_lock(734021,1) AS ok');
  assert.equal(acquired.rows[0].ok, true);
  console.log('CONCORRENZA | B acquisisce lock dopo rollback A: PASS');

  // Non usiamo richieste reali per UPDATE; leggiamo solo una richiesta eleggibile.
  const {rows} = await b.query(`
    SELECT r.* FROM richieste_pop_bus r
    WHERE r.stato='in_attesa' AND r.start_datetime > NOW() AND r.corsa_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM popbus_attivazione_richieste ar
        WHERE ar.richiesta_id=r.id AND ar.attiva
      )
    ORDER BY r.start_datetime,r.id LIMIT 1
  `);
  if (rows.length) {
    const snapshot = rows[0];
    const fp = fingerprint(snapshot);
    const eligible = r => r.stato === 'in_attesa' && r.corsa_id == null && fingerprint(r) === fp;
    assert.equal(eligible(snapshot), true);
    assert.equal(eligible({...snapshot, stato:'in_lavorazione'}), false);
    assert.equal(eligible({...snapshot, corsa_id:123456}), false);
    assert.equal(eligible({...snapshot, posti_richiesti:Number(snapshot.posti_richiesti)+1}), false);
    console.log(`SNAPSHOT | richiesta ${snapshot.id}: stato/corsa/posti modificati vengono scartati (simulazione JS): PASS`);
    const active = await b.query('SELECT EXISTS(SELECT 1 FROM popbus_attivazione_richieste WHERE richiesta_id=$1 AND attiva) AS reserved',[snapshot.id]);
    assert.equal(active.rows[0].reserved, false);
    console.log('DB | richiesta campione senza associazioni attive: PASS');
  } else {
    console.log('SNAPSHOT | SKIP: nessuna richiesta futura eleggibile. Non attribuire PASS alla rivalidazione dinamica.');
  }
  await b.query('ROLLBACK'); txB = false;
  console.log('ESITO: PASS audit statico + lock; rivalidazione dinamica simulata:', rows.length ? 'PASS' : 'SKIP');
  console.log('NON VERIFICATO: doppio worker reale, commit A e rifiuto B, offerte duplicate.');
} catch (e) {
  failed = true;
  console.error('ESITO FINALE: FAIL', e.code || '', e.message);
} finally {
  if (txA && a) await a.query('ROLLBACK').catch(()=>{});
  if (txB && b) await b.query('ROLLBACK').catch(()=>{});
  a?.release(); b?.release();
  await pool.end().catch(()=>{});
}
if (failed) process.exitCode = 1;
