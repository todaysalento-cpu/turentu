// TURENTU — Diagnostica PIXEL-first multimissione
// Esecuzione singola, senza modifiche ai dati di input.

import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione }
  from '../services/popbus/v2/pixel-first-multimission-service.js';

process.env.POPBUS_PIXEL_DIAGNOSTICA = '1';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

try {
  assert(
    process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED !== '1',
    'LIVE_APPROVED deve essere disabilitato'
  );

  assert(
    process.env.POPBUS_PIXEL_FIRST_ENABLED !== 'true',
    'Scheduler PIXEL-first non deve essere abilitato'
  );

  const { rows } = await pool.query(`
    SELECT current_database() AS db
  `);

  assert(
    rows[0]?.db === 'corse_db',
    'Database inatteso'
  );

  console.log('======================================');
  console.log('TURENTU PIXEL-FIRST MULTIMISSIONE');
  console.log('DIAGNOSTICA ECONOMICA');
  console.log('MODALITA: ROLLBACK_ONLY');
  console.log('======================================');

  const result = await processaPixelFirstMultimissione({
    pool,
    mode: 'ROLLBACK_ONLY'
  });

  assert(
    result?.persistita !== true,
    'ERRORE: il servizio segnala una persistenza'
  );

  console.log(
    'PIXEL_MULTIMISSIONE_DIAGNOSTICA_JSON:',
    JSON.stringify(result, null, 2)
  );

  console.log('PIXEL_MULTIMISSIONE_DIAGNOSTICA_OK');

} catch (error) {
  console.error(
    'PIXEL_MULTIMISSIONE_DIAGNOSTICA_ERROR:',
    error.stack || error.message
  );

  process.exitCode = 1;

} finally {
  await pool.end();
}