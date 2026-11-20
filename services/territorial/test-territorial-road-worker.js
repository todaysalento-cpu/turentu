
import { pool } from '../../db/db.js';

import {
  eseguiWorkerTerritoriale
} from './territorial-road-worker.service.js';

try {
  console.log('=== WORKER TERRITORIALE V1 ===');

  // Snapshot iniziale.
  const prima = await pool.query(`
    SELECT
      (SELECT COUNT(*)
       FROM territorial_hub_coda_stradale
       WHERE scenario_km = 15
         AND stato = 'in_attesa') AS in_attesa,
      (SELECT COUNT(*)
       FROM territorial_hub_matrice_stradale) AS matrice
  `);

  const risultato = await eseguiWorkerTerritoriale({
    simulazione: true,
    batchSize: 5
  });

  console.table(risultato.risultati);

  // Snapshot finale.
  const dopo = await pool.query(`
    SELECT
      (SELECT COUNT(*)
       FROM territorial_hub_coda_stradale
       WHERE scenario_km = 15
         AND stato = 'in_attesa') AS in_attesa,
      (SELECT COUNT(*)
       FROM territorial_hub_matrice_stradale) AS matrice
  `);

  if (
    prima.rows[0].in_attesa !== dopo.rows[0].in_attesa ||
    prima.rows[0].matrice !== dopo.rows[0].matrice
  ) {
    throw new Error('Stato database modificato');
  }

  if (
    risultato.verifiche_lette !== 5 ||
    risultato.risultati.length !== 5 ||
    risultato.chiamate_google !== 0 ||
    risultato.scritture_database !== 0 ||
    risultato.risultati.some(
      r => r.errore || r.persistito !== false
    )
  ) {
    throw new Error('Risultato worker non valido');
  }

  console.log('\nTEST WORKER SUPERATO');
  console.log('Verifiche simulate:', risultato.verifiche_lette);
  console.log('Google: 0 chiamate');
  console.log('Database: nessuna scrittura');

} catch (error) {
  console.error('TEST FALLITO:', error.message);
  process.exitCode = 1;

} finally {
  await pool.end();
}
