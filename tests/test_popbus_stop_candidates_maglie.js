
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';
import { cercaFermateCandidate } from '../services/popbus/v2/popbus-stop-candidates.service.js';

const richiestaIds = [307, 308, 309];
const client = await pool.connect();

try {
  console.log('=== TEST CANDIDATE FERMATE PIXEL ===');
  console.log('Modalità: sola lettura');
  console.log('Richieste:', richiestaIds.join(', '));

  await client.query('BEGIN READ ONLY');

  const risultati = await cercaFermateCandidate({
    client,
    richiestaIds,
    raggioMetri: 1500,
    limite: 5
  });

  for (const richiesta of risultati) {
    console.log(`\nRichiesta ${richiesta.richiesta_id}`);
    console.log('Salite:', richiesta.salita.map(s => ({
      id: s.fermata_id,
      nome: s.nome,
      distanza_m: Math.round(s.distanza_metri),
      verificata: s.verificata
    })));
    console.log('Discese:', richiesta.discesa.map(s => ({
      id: s.fermata_id,
      nome: s.nome,
      distanza_m: Math.round(s.distanza_metri),
      verificata: s.verificata
    })));
    console.log('Completa:', richiesta.completa);
  }

  const idsTrovati = new Set(
    risultati.flatMap(r => [...r.salita, ...r.discesa])
      .map(s => s.fermata_id)
  );

  console.log('\nFermate 14 e 15 trovate:', {
    fermata14: idsTrovati.has(14),
    fermata15: idsTrovati.has(15)
  });

  console.log(
    '\nNOTA: il test verifica le fermate vicine alle coordinate delle richieste,',
    'non garantisce che entrambe siano vicine a ogni richiesta.'
  );

  await client.query('ROLLBACK');
  console.log('\nPASS: query eseguita in sola lettura.');
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  console.error('FAIL:', error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
