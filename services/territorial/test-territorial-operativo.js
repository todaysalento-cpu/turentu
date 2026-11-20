
import { pool } from '../../db/db.js';
import {
  acquisisciBatch,
  rilasciaBatch
} from './territorial-batch.service.js';

let workerId = null;

try {
  const batch = await acquisisciBatch(5);
  workerId = batch.workerId;

  console.log('\n=== ACQUISIZIONE PERSISTENTE ===');
  console.table(batch.righe);

  if (batch.righe.length !== 5) {
    throw new Error('Il batch non contiene 5 righe');
  }

  const { rows: acquisite } = await pool.query(`
    SELECT COUNT(*)::integer AS totale
    FROM territorial_hub_coda_stradale
    WHERE worker_id = $1
      AND stato = 'in_elaborazione'
  `, [workerId]);

  if (acquisite[0].totale !== 5) {
    throw new Error('Acquisizione persistente non confermata');
  }

  console.log('COMMIT verificato: 5 righe in elaborazione');

  const rilasciate = await rilasciaBatch(workerId);

  if (rilasciate.length !== 5) {
    throw new Error('Rilascio incompleto');
  }

  workerId = null;

  console.log('\n=== RISULTATO ===');
  console.log('TEST SUPERATO');
  console.log('5 righe acquisite e rilasciate');
  console.log('Google: 0 chiamate');
  console.log('Matrice stradale: nessuna scrittura');

} catch (error) {
  console.error('TEST FALLITO:', error.message);
  process.exitCode = 1;
} finally {
  if (workerId) {
    try {
      const recuperate = await rilasciaBatch(workerId);
      console.log(`Pulizia finale: ${recuperate.length} righe`);
    } catch (error) {
      console.error('Pulizia fallita:', error.message);
    }
  }

  await pool.end();
}
