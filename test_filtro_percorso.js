import 'dotenv/config'; 
import { filterDisponibilita } from './services/search/engine/availability.engine.js';
import { CacheStore, loadCachesUltra } from './services/search/search.cache.js';

async function runTest() {
    try {
        console.log("🔄 Avvio sincronizzazione cache...");
        await loadCachesUltra(true); 
        
        // Verifica integrità cache
        if (!CacheStore.corseCache || CacheStore.corseCache.size === 0) {
            console.warn("⚠️ Attenzione: Cache vuota. Verifica la connessione al DB.");
            return;
        }

        const veicoli = CacheStore.veicoliCache;
        const disp = CacheStore.disponibilitaCache;
        const corse = CacheStore.corseCache;

        const now = new Date();
        const nowIso = now.toISOString();

        // Casi di test
        const testCases = [
            {
                label: "TRATTA LUNGA (Foggia -> Pescara)",
                richiesta: { 
                    coord: { lat: 41.48, lon: 15.58 }, 
                    coordDest: { lat: 42.46, lon: 14.21 }, 
                    posti_richiesti: 1,
                    start_datetime: nowIso 
                }
            },
            {
                label: "TRATTA LOCALE (Vicino ID:162 - Area Matera/Bari)",
                richiesta: { 
                    // Coordinate coerenti con ID 162 trovato nel tuo DB (40.66, 16.60)
                    coord: { lat: 40.66, lon: 16.60 }, 
                    coordDest: { lat: 40.67, lon: 16.61 }, 
                    posti_richiesti: 1,
                    start_datetime: nowIso 
                }
            }
        ];

        console.log(`📦 Cache caricata: ${corse.size} corse, ${veicoli.size} veicoli, ${disp.size} slot.`);

        for (const tc of testCases) {
            console.log(`\n🔎 ESECUZIONE TEST: ${tc.label}`);
            
            const { corse: compatibili, slots } = filterDisponibilita(
                tc.richiesta, 
                veicoli, 
                disp, 
                corse
            );
            
            console.log(`📊 Risultati: ${compatibili.length} corse compatibili, ${slots.length} slot disponibili.`);
            
            if (compatibili.length > 0) {
                compatibili.forEach(c => {
                    console.log(`✅ Corsa ID:${c.id} | ${c.localitaOrigine || 'N/A'} -> ${c.localitaDestinazione || 'N/A'}`);
                });
            } else {
                console.log(`ℹ️ Nessuna corsa trovata per questa posizione.`);
            }
        }

    } catch (error) {
        console.error("❌ Errore critico durante il test:", error);
    }
}

runTest();