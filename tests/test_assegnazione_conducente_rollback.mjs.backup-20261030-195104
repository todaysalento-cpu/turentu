import 'dotenv/config';
import pg from 'pg';
import { assegnaConducente, elencoAssegnazioniConducente } from '../services/conducenti/assegnazioni.service.js';

// Collocare il file in tests/ nel progetto backend.
// Nessun COMMIT. Un'unica connessione, transazione con ROLLBACK obbligatorio.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }, max: 1 });
let client;
let started = false;
let failed = false;
const base = { operatoreId: 2, conducenteId: 101, veicoloId: 366, corsaId: 925, modalita: 'manuale' };

async function test(name, fn) {
  await client.query('SAVEPOINT test_case');
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL ${name}: ${e.message}`);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT test_case');
    await client.query('RELEASE SAVEPOINT test_case');
  }
}

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL assente');
  client = await pool.connect();
  await client.query('BEGIN READ WRITE');
  started = true;
  await client.query("SET LOCAL lock_timeout = '2s'");
  await client.query("SET LOCAL statement_timeout = '12s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");

  const check = await client.query(`
    SELECT EXISTS (SELECT 1 FROM conducenti_operatori WHERE operatore_id=2 AND conducente_id=101 AND stato='attivo') AS rapporto,
           EXISTS (SELECT 1 FROM veicolo WHERE id=366 AND driver_id=2) AS veicolo,
           EXISTS (SELECT 1 FROM corse WHERE id=925 AND veicolo_id=366) AS corsa`);
  if (!Object.values(check.rows[0]).every(Boolean)) throw new Error('Prerequisiti non soddisfatti: ' + JSON.stringify(check.rows[0]));

  await test('assegnazione manuale e lettura conducente', async () => {
    const created = await assegnaConducente(client, { ...base, inizio: '2026-11-02T10:00:00+01:00', fine: '2026-11-02T11:00:00+01:00' });
    if (Number(created.conducente_id) !== 101 || Number(created.operatore_id) !== 2) throw new Error('Assegnazione errata');
    const rows = await elencoAssegnazioniConducente(client, 101);
    if (!rows.some(r => String(r.id) === String(created.id))) throw new Error('Assegnazione non visibile al conducente');
  });

  await test('rifiuto fuori turno senza deroga', async () => {
    try {
      await assegnaConducente(client, { ...base, inizio: '2026-11-03T10:00:00+01:00', fine: '2026-11-03T11:00:00+01:00' });
      throw new Error('ERRORE: assegnazione fuori turno accettata');
    } catch (e) {
      if (e.code !== 'CONDUCENTE_DEROGA_RICHIESTA') throw e;
    }
  });

  await test('rifiuto sovrapposizione', async () => {
    await assegnaConducente(client, { ...base, inizio: '2026-11-02T10:00:00+01:00', fine: '2026-11-02T11:00:00+01:00' });
    try {
      await assegnaConducente(client, { ...base, inizio: '2026-11-02T10:30:00+01:00', fine: '2026-11-02T11:30:00+01:00' });
      throw new Error('ERRORE: sovrapposizione accettata');
    } catch (e) {
      if (e.message !== 'Conducente già impegnato nel periodo') throw e;
    }
  });
} catch (e) {
  failed = true;
  console.error('ERRORE TEST:', e.message);
} finally {
  if (client) {
    if (started) {
      try { await client.query('ROLLBACK'); console.log('ROLLBACK ESEGUITO'); }
      catch (e) { failed = true; console.error('ROLLBACK FALLITO:', e.message); }
    }
    client.release(true);
  }
  await pool.end();
  console.log(failed ? 'ESITO: TEST NON SUPERATO' : 'ESITO: TUTTI I TEST SUPERATI');
  if (failed) process.exitCode = 1;
}
