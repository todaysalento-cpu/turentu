// Destinazione: tests/test-pixel-territorial-orchestrator.js
// Uso: node --env-file=.env tests/test-pixel-territorial-orchestrator.js 075088
// Per evitare chiamate Google accidentali, serve --live esplicito.
import { pool } from '../db/db.js';
import { diagnosticaFermateComunePixel } from '../services/pixel/pixel-territorial-orchestrator.service.js';

const args = process.argv.slice(2);
try {
  if (args.length !== 2 || args[0] !== '--live' || !/^\d{6}$/.test(args[1])) {
    throw new Error('Uso: node --env-file=.env tests\\test-pixel-territorial-orchestrator.js --live 075088');
  }
  const report = await diagnosticaFermateComunePixel(args[1]);
  console.log('PIXEL TERRITORIALE - DIAGNOSTICA COMUNALE (SOLA LETTURA)');
  console.log(report);
  if (report.stato === 'parziale') process.exitCode = 2;
} catch (error) {
  console.error('ERRORE:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
