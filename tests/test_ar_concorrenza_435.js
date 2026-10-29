/**
 * TURENTU - STEP 4.35A - Test reale dei lock PostgreSQL, SOLO ROLLBACK.
 * Eseguire ESCLUSIVAMENTE sul database di collaudo.
 * Non modifica dati: usa SELECT ... FOR UPDATE, NOWAIT e transazioni.
 * Verifica la serializzazione dei lock usati da accettaTrattaARAtomica.
 * NON dimostra ancora la concorrenza end-to-end di due accettazioni A/R.
 */
import { pool } from '../db/db.js';

let a, b;
let passed = 0;
let failed = false;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function begin(client) {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '1500ms'");
  await client.query("SET LOCAL statement_timeout = '5000ms'");
}

async function rollback(client) {
  if (client) await client.query('ROLLBACK');
}

async function test(name, fn) {
  await rollback(a);
  await rollback(b);
  try {
    await begin(a);
    await begin(b);
    await fn();
    passed++;
    console.log(`PASS ${passed}: ${name}`);
  } finally {
    await rollback(a);
    await rollback(b);
  }
}

try {
  a = await pool.connect();
  b = await pool.connect();
  assert(a.processID !== b.processID, 'Le connessioni non sono indipendenti');

  const { rows } = await a.query(`
    SELECT id FROM veicolo ORDER BY id LIMIT 2
  `);
  assert(rows.length >= 2, 'Servono almeno due veicoli esistenti per il test');
  const vehicleA = rows[0].id;
  const vehicleB = rows[1].id;
  console.log(`Veicoli di test: ${vehicleA}, ${vehicleB}`);
  console.log(`Connessioni PostgreSQL: ${a.processID}, ${b.processID}`);

  await test('due transazioni non possono bloccare lo stesso veicolo simultaneamente', async () => {
    await a.query('SELECT id FROM veicolo WHERE id=$1 FOR UPDATE', [vehicleA]);
    let error;
    try {
      await b.query('SELECT id FROM veicolo WHERE id=$1 FOR UPDATE NOWAIT', [vehicleA]);
    } catch (e) {
      error = e;
    }
    assert(error?.code === '55P03',
      `Atteso 55P03 (lock_not_available), ricevuto ${error?.code ?? 'SUCCESS'}`);
  });

  await test('il lock su un veicolo non blocca un veicolo diverso', async () => {
    await a.query('SELECT id FROM veicolo WHERE id=$1 FOR UPDATE', [vehicleA]);
    const { rows: locked } = await b.query(
      'SELECT id FROM veicolo WHERE id=$1 FOR UPDATE NOWAIT', [vehicleB]
    );
    assert(locked.length === 1 && Number(locked[0].id) === Number(vehicleB),
      'Il secondo veicolo non e stato acquisito');
  });

  await test('dopo il ROLLBACK il lock torna disponibile', async () => {
    await a.query('SELECT id FROM veicolo WHERE id=$1 FOR UPDATE', [vehicleA]);
    await rollback(a);
    const { rows: locked } = await b.query(
      'SELECT id FROM veicolo WHERE id=$1 FOR UPDATE NOWAIT', [vehicleA]
    );
    assert(locked.length === 1, 'Il lock non e stato liberato dal rollback');
  });

  console.log('Nessuna INSERT, UPDATE, DELETE o COMMIT eseguita.');
} catch (error) {
  failed = true;
  console.error('TEST FALLITO:', error?.code ?? error?.message, error);
} finally {
  for (const [name, client] of [['A', a], ['B', b]]) {
    if (!client) continue;
    try {
      await rollback(client);
      console.log(`ROLLBACK connessione ${name} eseguito`);
    } catch (error) {
      failed = true;
      console.error(`ROLLBACK connessione ${name} fallito:`, error);
    } finally {
      client.release();
    }
  }
  await pool.end();
}
console.log(`Risultato: ${passed}/3 test superati`);
if (failed || passed !== 3) process.exitCode = 1;
