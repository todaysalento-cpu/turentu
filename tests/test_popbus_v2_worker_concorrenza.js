/**
 * POPBUS V2 - audit del protocollo di concorrenza del worker.
 * SOLA LETTURA: non esegue il worker, non fa INSERT/UPDATE/DELETE/COMMIT.
 * Eseguire dalla root del progetto:
 * node --env-file=.env tests/test_popbus_v2_worker_concorrenza.js
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db/db.js';

const WORKER = path.resolve('services/popbus/v2/worker.js');
const LOCK_A = 734021;
const LOCK_B = 1;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(ok, message) { if (!ok) throw new Error(message); }

async function main() {
  console.log('=== POPBUS V2 | AUDIT CONCORRENZA WORKER | SOLA LETTURA ===');
  const code = await fs.readFile(WORKER, 'utf8');
  const lockMatches = [...code.matchAll(/pg_advisory_xact_lock\s*\(\s*734021\s*,\s*1\s*\)/g)];
  console.log('Worker:', WORKER);
  console.log('Lock transazionale (734021,1) nel codice:', lockMatches.length);
  assert(lockMatches.length >= 2, 'Attesi almeno due lock: fase iniziale e fase di prenotazione');
  assert(/FOR\s+UPDATE/i.test(code), 'SELECT FOR UPDATE non trovato nel worker');
  assert(/\bCOMMIT\b/i.test(code), 'COMMIT non trovato: ricontrollare il worker');
  console.log('Audit statico: PASS (lock presente in due punti e FOR UPDATE presente)');
  console.log('NOTA: audit statico non dimostra che ogni percorso di esecuzione sia protetto.');

  let a, b, txA = false, txB = false;
  try {
    a = await pool.connect();
    b = await pool.connect();
    const [idA, idB] = await Promise.all([
      a.query('SELECT pg_backend_pid() AS pid'),
      b.query('SELECT pg_backend_pid() AS pid')
    ]);
    console.log('Connessioni indipendenti:', idA.rows[0].pid, idB.rows[0].pid);
    assert(idA.rows[0].pid !== idB.rows[0].pid, 'Le connessioni devono essere distinte');

    await a.query('BEGIN READ ONLY'); txA = true;
    await a.query('SELECT pg_advisory_xact_lock($1,$2)', [LOCK_A, LOCK_B]);
    console.log('A | lock worker acquisito');

    await b.query('BEGIN READ ONLY'); txB = true;
    const first = await b.query('SELECT pg_try_advisory_xact_lock($1,$2) AS acquired', [LOCK_A, LOCK_B]);
    assert(first.rows[0].acquired === false, 'B ha acquisito un lock già detenuto da A');
    console.log('B | lock negato mentre A lo detiene: PASS');

    // READ ONLY impedisce qualunque modifica accidentale nelle due transazioni.
    const [visibleA, visibleB] = await Promise.all([
      a.query('SELECT COUNT(*)::int AS n FROM popbus_attivazioni WHERE veicolo_id=$1', [353]),
      b.query('SELECT COUNT(*)::int AS n FROM popbus_attivazioni WHERE veicolo_id=$1', [353])
    ]);
    console.log('Lettura attivazioni veicolo 353 | A:', visibleA.rows[0].n, '| B:', visibleB.rows[0].n);

    await a.query('ROLLBACK'); txA = false;
    const second = await b.query('SELECT pg_try_advisory_xact_lock($1,$2) AS acquired', [LOCK_A, LOCK_B]);
    assert(second.rows[0].acquired === true, 'B non acquisisce il lock dopo rollback di A');
    console.log('B | lock acquisito dopo rollback A: PASS');
    await b.query('ROLLBACK'); txB = false;

    // Il lock non deve restare acquisito fuori dalle transazioni.
    await a.query('BEGIN READ ONLY'); txA = true;
    const third = await a.query('SELECT pg_try_advisory_xact_lock($1,$2) AS acquired', [LOCK_A, LOCK_B]);
    assert(third.rows[0].acquired === true, 'Lock transazionale rimasto occupato');
    await a.query('ROLLBACK'); txA = false;
    console.log('Rilascio lock transazionale: PASS');
    console.log('ESITO FINALE: PASS - protocollo di lock verificato, nessuna scrittura');
    console.log('NON VERIFICATO: due worker reali, doppie offerte, race dopo routing, commit del worker.');
  } finally {
    if (a && txA) { try { await a.query('ROLLBACK'); } catch {} }
    if (b && txB) { try { await b.query('ROLLBACK'); } catch {} }
    a?.release(); b?.release();
    await pool.end();
  }
}

main().catch(err => { console.error('ESITO FINALE: FAIL', err.message); process.exitCode = 1; });
