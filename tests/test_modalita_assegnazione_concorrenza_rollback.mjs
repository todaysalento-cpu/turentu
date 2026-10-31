// Turentu - test PostgreSQL reale del lock per operatore, senza scritture.
// Esecuzione: node --env-file=.env tests/test_modalita_assegnazione_concorrenza_rollback.mjs
// Richiede: TURENTU_TEST_OPERATORE_ID=<id operatore di prova>
// Non modifica impostazioni, corse o assegnazioni. Entrambi i client eseguono ROLLBACK.
import { pool } from '../db/db.js';

const LOCK_NAMESPACE = 731904;
const id = Number(process.env.TURENTU_TEST_OPERATORE_ID);
if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) {
  console.error('ERRORE: impostare TURENTU_TEST_OPERATORE_ID con ID intero positivo di un operatore di prova (max 2147483647).');
  process.exitCode = 1;
} else {
  let a, b;
  let inA = false, inB = false;
  try {
    a = await pool.connect();
    b = await pool.connect();
    await a.query('BEGIN'); inA = true;
    await b.query('BEGIN'); inB = true;
    await a.query("SET LOCAL lock_timeout = '4s'");
    await b.query("SET LOCAL lock_timeout = '4s'");
    await a.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [LOCK_NAMESPACE, id]);
    console.log('PASS client A acquisisce lock');

    const first = await b.query('SELECT pg_try_advisory_xact_lock($1::integer,$2::integer) AS acquired', [LOCK_NAMESPACE, id]);
    if (first.rows[0]?.acquired !== false) throw new Error('Client B ha acquisito lock mentre A lo detiene');
    console.log('PASS client B non acquisisce lock mentre A lo detiene');

    await a.query('ROLLBACK'); inA = false;
    const second = await b.query('SELECT pg_try_advisory_xact_lock($1::integer,$2::integer) AS acquired', [LOCK_NAMESPACE, id]);
    if (second.rows[0]?.acquired !== true) throw new Error('Client B non acquisisce lock dopo ROLLBACK A');
    console.log('PASS client B acquisisce lock dopo ROLLBACK A');

    const result = await b.query(
      'SELECT modalita FROM impostazioni_assegnazione_operatori WHERE operatore_id=$1', [id]
    );
    console.log('PASS lettura impostazione sotto lock:', result.rows[0]?.modalita ?? 'manuale (default)');
    await b.query('ROLLBACK'); inB = false;
    console.log('ESITO: LOCK TRANSAZIONALE VERIFICATO - ZERO SCRITTURE - ROLLBACK ESEGUITI');
  } catch (err) {
    console.error('TEST FALLITO:', err.message);
    process.exitCode = 1;
  } finally {
    if (a) {
      if (inA) { try { await a.query('ROLLBACK'); } catch (e) { console.error('ROLLBACK A:', e.message); } }
      a.release();
    }
    if (b) {
      if (inB) { try { await b.query('ROLLBACK'); } catch (e) { console.error('ROLLBACK B:', e.message); } }
      b.release();
    }
    await pool.end();
  }
}
