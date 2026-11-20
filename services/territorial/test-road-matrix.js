
import { pool } from '../../db/db.js';
import { previewTerritorialRoadMatrix } from './territorial-road-matrix.service.js';

try {
  const risultato = await previewTerritorialRoadMatrix({
    scenarioKm: 15,
    limit: 5,
  });

  console.log(JSON.stringify(risultato, null, 2));
} catch (error) {
  console.error('Errore dry-run territoriale:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
