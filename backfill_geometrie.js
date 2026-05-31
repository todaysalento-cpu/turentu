// IMPORTANTE: Inizializza dotenv PRIMA di importare qualsiasi altro modulo
import 'dotenv/config'; 

import { pool } from './db/db.js';
import polyline from 'polyline';
import ngeohash from 'ngeohash';
import { getRouteGeometry } from './utils/maps.util.js'; 

async function backfill() {
  // Verifica rapida della chiave API
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error("❌ ERRORE: GOOGLE_MAPS_API_KEY non trovata nel file .env!");
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    // Recupera solo le corse necessarie
    const res = await client.query(`
      SELECT id, 
             ST_Y(origine::geometry) as lat1, ST_X(origine::geometry) as lon1, 
             ST_Y(destinazione::geometry) as lat2, ST_X(destinazione::geometry) as lon2 
      FROM corse 
      WHERE percorso_polyline IS NULL
    `);
    
    console.log(`🚀 Trovate ${res.rows.length} corse da aggiornare.`);

    for (const c of res.rows) {
      try {
        // 1. Chiamata REALE al servizio di routing tramite utility
        const route = await getRouteGeometry(
            { lat: c.lat1, lon: c.lon1 }, 
            { lat: c.lat2, lon: c.lon2 }
        );
        
        // 2. Decodifica e generazione hash
        const decoded = polyline.decode(route.polyline);
        const hashes = decoded.map(p => ngeohash.encode(p[0], p[1], 5));

        // 3. Aggiornamento nel DB
        await client.query(
          `UPDATE corse SET percorso_polyline = $1, path_geohashes = $2, distanza = $3 WHERE id = $4`,
          [route.polyline, hashes, route.distanza / 1000, c.id]
        );
        
        console.log(`✅ Corsa ${c.id} aggiornata: ${route.distanza / 1000} km.`);
      } catch (err) {
        // Logging dell'errore specifico, senza interrompere l'intero processo
        console.error(`💥 Errore corsa ${c.id}: ${err.message}`);
      }
    }
  } catch (dbErr) {
    console.error("💥 Errore di connessione al database:", dbErr.message);
  } finally {
    client.release();
    console.log("🏁 Operazione conclusa.");
    process.exit(0);
  }
}

backfill();