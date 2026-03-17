// services/search/print_geohash_corse_oggi.js
import { pool } from '../../db/db.js';
import ngeohash from 'ngeohash';

(async () => {
  try {
    // Date di oggi (inizio e fine giorno)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const res = await pool.query(
      `
      SELECT 
        id,
        origine_address,
        destinazione_address,
        ST_X(origine::geometry) AS origine_lon,
        ST_Y(origine::geometry) AS origine_lat,
        ST_X(destinazione::geometry) AS dest_lon,
        ST_Y(destinazione::geometry) AS dest_lat,
        start_datetime,
        arrivo_datetime
      FROM corse
      WHERE start_datetime >= $1 AND start_datetime <= $2
      ORDER BY start_datetime
      `,
      [todayStart, todayEnd]
    );

    console.log(`📦 Corse di oggi (${res.rows.length}):`);
    res.rows.forEach(corsa => {
      const geohashOrigine = ngeohash.encode(corsa.origine_lat, corsa.origine_lon, 5);
      const geohashDest = ngeohash.encode(corsa.dest_lat, corsa.dest_lon, 5);

      console.log(`ID: ${corsa.id}`);
      console.log(`  Origine: ${corsa.origine_address} (${corsa.origine_lat}, ${corsa.origine_lon}) geohash: ${geohashOrigine}`);
      console.log(`  Destinazione: ${corsa.destinazione_address} (${corsa.dest_lat}, ${corsa.dest_lon}) geohash: ${geohashDest}`);
      console.log(`  Start: ${corsa.start_datetime}, Arrivo: ${corsa.arrivo_datetime}`);
      console.log('-------------------------');
    });
  } catch (err) {
    console.error('❌ Errore query:', err);
  } finally {
    await pool.end();
  }
})();