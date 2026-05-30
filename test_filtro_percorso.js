import 'dotenv/config'; 
import { filterDisponibilita } from './services/search/engine/availability.engine.js';
import { CacheStore, loadCachesUltra } from './services/search/search.cache.js';

function getDist(p1, p2) {
    const [lat1, lon1] = Array.isArray(p1) ? p1 : [p1.lat || p1.latitude, p1.lon || p1.lng || p1.longitude];
    const [lat2, lon2] = Array.isArray(p2) ? p2 : [p2.lat || p2.latitude, p2.lon || p2.lng || p2.longitude];
    
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcolaDistanzaPercorso(punti) {
    if (!punti || punti.length < 2) return 0;
    let distanza = 0;
    for (let i = 0; i < punti.length - 1; i++) {
        distanza += getDist(punti[i], punti[i + 1]);
    }
    return distanza;
}

async function runTest() {
    try {
        console.log("🔄 Avvio sincronizzazione cache...");
        await loadCachesUltra(true); 
        const corseArray = Array.from(CacheStore.corseCache.values());

        // Definizione casi di test
        const testCases = [
            {
                label: "TRATTA LUNGA (Foggia -> Pescara)",
                richiesta: { coord: { lat: 41.48, lon: 15.58 }, coordDest: { lat: 42.46, lon: 14.21 }, posti_richiesti: 1 }
            },
            {
                label: "TRATTA BREVE (Test Locale)",
                richiesta: { coord: { lat: 41.46, lon: 15.54 }, coordDest: { lat: 41.47, lon: 15.56 }, posti_richiesti: 1 }
            }
        ];

        for (const tc of testCases) {
            console.log(`\n\n🔎 ESECUZIONE TEST: ${tc.label}`);
            const { corse: compatibili } = filterDisponibilita(tc.richiesta, [], [], corseArray);
            
            if (compatibili.length === 0) {
                console.log("⚠️ Nessuna corsa compatibile trovata per questa tratta.");
            } else {
                compatibili.forEach(c => {
                    const distSegm = calcolaDistanzaPercorso(c.percorsoVisualizzato || []);
                    console.log(`✅ ID: ${c.id} | ${c.localitaOrigine} -> ${c.localitaDestinazione}`);
                    console.log(`   📏 Segmento calcolato: ${distSegm.toFixed(2)} km`);
                });
            }
        }

    } catch (error) {
        console.error("❌ Errore critico:", error);
    }
}

runTest();