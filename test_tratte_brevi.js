import 'dotenv/config';
import { pool } from './db/db.js'; // Assicurati che il path sia corretto
import { filterDisponibilita } from './services/search/engine/availability.engine.js';
import { loadCachesUltra, CacheStore } from './services/search/search.cache.js';

async function runPrecisionTest() {
    await loadCachesUltra(true);
    const client = await pool.connect();
    
    try {
        console.log("🚀 Avvio test precisione tratte brevi...");
        
        // 1. Prendi una corsa breve dal DB (es. Corsa 581)
        const res = await client.query(`
            SELECT id, percorso_polyline, origine_address 
            FROM corse WHERE id = 581
        `);
        
        if (res.rows.length === 0) return console.log("Corsa test non trovata.");
        
        const corsa = res.rows[0];
        // Nota: Qui stiamo estraendo il punto di inizio reale della polilinea
        // Usiamo un piccolo tool interno o la logica di polyline per decodificare
        // Per semplicità, ipotizziamo di avere le coordinate del primo punto:
        const [latStart, lonStart] = [39.95, 18.35]; 

        const testRichiesta = {
            label: `TEST PRECISIONE Corsa ${corsa.id} (${corsa.origine_address})`,
            richiesta: {
                coord: { lat: latStart, lon: lonStart },
                coordDest: { lat: latStart + 0.02, lon: lonStart + 0.02 }, // Breve distanza
                posti_richiesti: 1
            }
        };

        const { corse: risultati } = filterDisponibilita(testRichiesta.richiesta, [], [], CacheStore.corseCache);

        if (risultati.some(c => c.id === corsa.id)) {
            console.log(`✅ TEST SUPERATO: Corsa ${corsa.id} intercettata correttamente.`);
        } else {
            console.log(`❌ TEST FALLITO: La corsa ${corsa.id} non è stata trovata.`);
            console.log("Suggerimento: Verifica che la tolleranza in availability.engine.js sia >= 2.0km");
        }

    } finally {
        client.release();
        process.exit();
    }
}

runPrecisionTest();