// TURENTU - test diagnostico POPBUS A/R Fase 3 (Render SSL)
// Salvare come tests/test-popbus-ar-coordinator-fase3.js
// Eseguire: node --env-file=.env tests/test-popbus-ar-coordinator-fase3.js <attivazione_id>
// Nessuna scrittura: transazione READ ONLY REPEATABLE READ e ROLLBACK.
import pg from 'pg';
import { analizzaDipendenzeAR } from '../services/popbus/v2/popbus-ar-coordinator.service.js';

const id = Number(process.argv[2]);
if (!Number.isSafeInteger(id) || id <= 0) {
  console.error('Uso: node tests/test-popbus-ar-coordinator-fase3.js <attivazione_id>');
  process.exitCode = 2;
} else if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL non configurata. Non inserire credenziali nei log.');
  process.exitCode = 2;
} else {
  // Allineato al test di connessione Render riuscito. Questa opzione
  // disabilita la verifica del certificato: usare solo per la diagnostica
  // temporanea e sostituire con una CA attendibile in produzione.
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });
  let connected = false;
  let transactionStarted = false;
  try {
    await client.connect();
    connected = true;
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionStarted = true;
    const result = await analizzaDipendenzeAR(client, id);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('TEST FALLITO:', err.code || 'ERROR', err.message);
    process.exitCode = 1;
  } finally {
    if (connected) {
      if (transactionStarted) {
        try { await client.query('ROLLBACK'); }
        catch (err) {
          console.error('ROLLBACK FALLITO:', err.code || 'ERROR', err.message);
          process.exitCode = 1;
        }
      }
      try { await client.end(); }
      catch (err) {
        console.error('CHIUSURA CONNESSIONE FALLITA:', err.code || 'ERROR', err.message);
        process.exitCode = 1;
      }
    }
  }
}
