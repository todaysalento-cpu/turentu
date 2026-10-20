// Destinazione: tests/test_pixel_bootstrap_readonly.js
// Esecuzione: node --env-file=.env tests\test_pixel_bootstrap_readonly.js
// SOLA LETTURA: non apre transazioni di scrittura e non modifica dati.
import { pool } from '../db/db.js';
import { diagnosticaBootstrapPixel } from '../services/pixel/pixel.orchestrator.service.js';

const client = await pool.connect();
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '120s'");
  const report = await diagnosticaBootstrapPixel({ client,
    maxRichieste: 100, maxDirettrici: 500, abilitaVariantiP1: true });
  console.log('PIXEL BOOTSTRAP DIAGNOSTICO:', JSON.stringify(report, null, 2));
  await client.query('ROLLBACK');
  console.log('TEST COMPLETATO: nessuna scrittura, transazione READ ONLY terminata.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('TEST PIXEL FALLITO:', error.stack || error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
