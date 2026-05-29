import { pool } from './db/db.js';
import polyline from 'polyline';
import ngeohash from 'ngeohash';

async function backfill() {
  const client = await pool.connect();
  try {
    // Recupera corse senza geometrie
    const res = await client.query(`SELECT id, ST_Y(origine::geometry) as lat1, ST_X(origine::geometry) as lon1, ST_Y(destinazione::geometry) as lat2, ST_X(destinazione::geometry) as lon2 FROM corse WHERE percorso_polyline IS NULL`);
    
    console.log(`Trovate ${res.rows.length} corse da aggiornare...`);

    for (const c of res.rows) {
      // 1. Qui dovresti chiamare il tuo provider di mappe (es. OSRM)
      // Esempio: const route = await getRoute(c.lat1, c.lon1, c.lat2, c.lon2);
      
      // MOCK DATA: Solo per vedere se il DB accetta l'update
      const mockPoints = [[c.lat1, c.lon1], [c.lat2, c.lon2]];
      const poly = polyline.encode(mockPoints);
      const hashes = mockPoints.map(p => ngeohash.encode(p[0], p[1], 5));

      // 2. Aggiorna il DB
      await client.query(
        `UPDATE corse SET percorso_polyline = $1, path_geohashes = $2 WHERE id = $3`,
        [poly, hashes, c.id]
      );
      console.log(`Corsa ${c.id} aggiornata.`);
    }
  } finally {
    client.release();
  }
}
backfill();