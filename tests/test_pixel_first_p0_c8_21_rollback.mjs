// TURENTU — P0-C8.21: prima invocazione isolata PIXEL-first.
// Salvare come tests/test_pixel_first_p0_c8_21_rollback.mjs
// SOLO rollback: nessun COMMIT delle nuove attivazioni, nessuna Stripe.
// ATTENZIONE: esegue routing reale e interrogazioni DB; le sequenze PG
// possono avanzare anche quando la transazione viene annullata.
import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';

let exitCode = 0;
try {
  console.log('=== P0-C8.21 / PIXEL FIRST / ROLLBACK ONLY ===');
  const result = await processaPixelFirstMultimissione({
    pool,
    mode: 'ROLLBACK_ONLY'
  });
  console.log('RISULTATO:', JSON.stringify(result, null, 2));
  if (result?.persistita === true) {
    throw new Error('ERRORE CRITICO: persistita=true durante ROLLBACK_ONLY');
  }
  console.log('OK: invocazione terminata senza COMMIT produttivo.');
  if (!result?.attivazioneId) {
    console.log('NOTA: nessun ciclo persistibile trovato. Non equivale a un E2E positivo.');
  }
} catch (err) {
  exitCode = 1;
  console.error('ERRORE PIXEL-FIRST:', err?.stack ?? String(err));
  console.error('Nessuna attivazione deve essere abilitata LIVE finche il problema non e risolto.');
} finally {
  try {
    await pool.end();
  } catch (err) {
    exitCode = 1;
    console.error('ERRORE CHIUSURA POOL:', err?.stack ?? String(err));
  }
  process.exitCode = exitCode;
}
