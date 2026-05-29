import ngeohash from 'ngeohash';
import polyline from 'polyline';
import { pool } from './db/db.js';

async function rigeneraTuttiGeohash() {
    console.log("🔍 Ricerca corse da aggiornare o ottimizzare...");
    
    // Recuperiamo id, polilinea e distanza per calcolare meglio gli hash
    const result = await pool.query(`SELECT id, percorso_polyline, distanza FROM corse WHERE percorso_polyline IS NOT NULL`);
    const rows = result.rows; 
    
    console.log(`🚀 Trovate ${rows.length} corse da elaborare.`);

    for (const row of rows) {
        try {
            const decoded = polyline.decode(row.percorso_polyline);
            
            // LOGICA DINAMICA:
            // Se la distanza è 0 o mancante, usiamo un fallback di 10 punti.
            // Altrimenti, 1 punto ogni 50km, con un minimo di 2 e un massimo di 20 punti.
            const km = parseFloat(row.distanza) || 0;
            const puntiTarget = km > 0 ? Math.min(20, Math.max(2, Math.floor(km / 50))) : 10;
            
            const step = Math.max(1, Math.floor(decoded.length / puntiTarget));
            
            const hashes = decoded
                .filter((_, i) => i % step === 0)
                .map(c => ngeohash.encode(c[0], c[1], 5));
            
            // Aggiungiamo sempre l'ultimo punto per precisione sull'arrivo
            if (decoded.length > 0) {
                const lastPoint = decoded[decoded.length - 1];
                hashes.push(ngeohash.encode(lastPoint[0], lastPoint[1], 5));
            }
            
            const uniqueHashes = [...new Set(hashes)];
            
            // Aggiornamento nel DB
            await pool.query('UPDATE corse SET path_geohashes = $1 WHERE id = $2', [uniqueHashes, row.id]);
            
            console.log(`✅ Corsa ${row.id} (${km.toFixed(0)}km): ${uniqueHashes.length} geohash.`);
        } catch (err) {
            console.error(`💥 Errore sulla corsa ${row.id}:`, err);
        }
    }
}

// Avvio esecuzione
rigeneraTuttiGeohash()
    .then(() => {
        console.log("🏁 Migrazione completata con successo!");
        process.exit(0);
    })
    .catch(err => {
        console.error("💥 Errore fatale:", err);
        process.exit(1);
    });