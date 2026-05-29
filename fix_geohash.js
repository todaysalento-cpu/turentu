import 'dotenv/config'; 
import { pool } from './db/db.js';
import { getRouteGeometry } from './utils/maps.util.js'; 
import ngeohash from 'ngeohash';
import polyline from 'polyline';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fixDefinitivo() {
    console.log("🚀 Avvio riallineamento corse...");
    
    // CORREZIONE: Usiamo ST_Y e ST_X per convertire il formato binario geography di PostGIS
    const query = `
        SELECT id, 
               ST_Y(origine::geometry) as lat_o, ST_X(origine::geometry) as lon_o,
               ST_Y(destinazione::geometry) as lat_d, ST_X(destinazione::geometry) as lon_d
        FROM corse 
        WHERE origine IS NOT NULL AND destinazione IS NOT NULL
    `;
    
    const result = await pool.query(query);
    const rows = result.rows;
    console.log(`📦 Trovate ${rows.length} corse da elaborare.`);

    for (const row of rows) {
        try {
            // Formattazione per la funzione getRouteGeometry
            const origine = { lat: row.lat_o, lon: row.lon_o };
            const destinazione = { lat: row.lat_d, lon: row.lon_d };

            // 1. Scarichiamo la geometria dettagliata
            const route = await getRouteGeometry(origine, destinazione);
            
            // 2. Decodifichiamo la polilinea
            const decoded = polyline.decode(route.polyline);
            
            // 3. Calcolo dinamico geohash
            const km = route.distanza / 1000;
            const puntiTarget = Math.min(25, Math.max(3, Math.floor(km / 40)));
            const step = Math.max(1, Math.floor(decoded.length / puntiTarget));
            
            const hashes = [];
            for (let i = 0; i < decoded.length; i += step) {
                hashes.push(ngeohash.encode(decoded[i][0], decoded[i][1], 6));
            }
            
            // Aggiunta forzata inizio e fine
            hashes.push(ngeohash.encode(decoded[0][0], decoded[0][1], 6));
            hashes.push(ngeohash.encode(decoded[decoded.length - 1][0], decoded[decoded.length - 1][1], 6));
            
            const uniqueHashes = [...new Set(hashes)];

            // 4. Update nel DB
            await pool.query(
                'UPDATE corse SET percorso_polyline = $1, path_geohashes = $2, distanza = $3 WHERE id = $4',
                [route.polyline, uniqueHashes, km, row.id]
            );
            
            console.log(`✅ Corsa ${row.id}: Aggiornata con ${uniqueHashes.length} geohash.`);
            
            await delay(100); 
            
        } catch (err) {
            console.error(`💥 Errore corsa ${row.id}: ${err.message}`);
        }
    }
}

fixDefinitivo()
    .then(() => {
        console.log("🏁 Migrazione completata!");
        process.exit(0);
    })
    .catch(err => {
        console.error("💥 Errore fatale:", err);
        process.exit(1);
    });