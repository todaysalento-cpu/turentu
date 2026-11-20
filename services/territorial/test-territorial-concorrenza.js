
import { pool } from '../../db/db.js';
import {
  acquisisciBatch,
  rilasciaBatch
} from './territorial-batch.service.js';

const workerIds = [];

try {
  console.log('Avvio simultaneo di due worker...');

  const risultati = await Promise.allSettled([
    acquisisciBatch(5),
    acquisisciBatch(5)
  ]);

  const errori = risultati.filter(r => r.status === 'rejected');

  const batch = risultati
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  for (const b of batch) {
    workerIds.push(b.workerId);
  }

  if (errori.length) {
    throw new Error(
      errori.map(e => e.reason?.message).join('; ')
    );
  }

  const [a, b] = batch;

  console.log('\n=== WORKER A ===');
  console.table(a.righe);

  console.log('\n=== WORKER B ===');
  console.table(b.righe);

  const idsA = a.righe.map(r => String(r.id));
  const idsB = b.righe.map(r => String(r.id));

  const duplicati = idsA.filter(id => idsB.includes(id));

  console.log('\n=== VERIFICA CONCORRENZA ===');
  console.log('Worker A:', idsA.length);
  console.log('Worker B:', idsB.length);
  console.log('Duplicati:', duplicati.length);

  if (
    idsA.length !== 5 ||
    idsB.length !== 5 ||
    duplicati.length !== 0
  ) {
    throw new Error('Test concorrenza non superato');
  }

  console.log('\nTEST CONCORRENZA SUPERATO');

} catch (error) {
  console.error('TEST FALLITO:', error.message);
  process.exitCode = 1;
} finally {
  for (const workerId of workerIds) {
    try {
      const righe = await rilasciaBatch(workerId);
      console.log(
        `Rilasciate ${righe.length} righe per ${workerId}`
      );
    } catch (error) {
      console.error('Errore rilascio:', error.message);
      process.exitCode = 1;
    }
  }

  await pool.end();
}
