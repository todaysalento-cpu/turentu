// Place in tests/ and execute: node tests/test-pixel-territorial-config.js
import { pool } from '../db/db.js';
import { diagnosticaNodoTerritoriale } from '../services/pixel/pixel-territorial-config.service.js';

try {
  const { rows } = await pool.query(`
    SELECT id, nome,
           ST_Y(posizione::geometry) AS lat,
           ST_X(posizione::geometry) AS lon
    FROM public.nodi_territoriali
    WHERE id = ANY($1::bigint[]) AND attivo = TRUE
    ORDER BY id`, [[7, 8]]);
  if (rows.length !== 2) throw new Error('Nodi 7 e 8 non entrambi disponibili');
  for (const node of rows) {
    try {
      console.log(JSON.stringify(await diagnosticaNodoTerritoriale(node), null, 2));
    } catch (error) {
      console.error(`Nodo ${node.id}: ${error.message}`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
