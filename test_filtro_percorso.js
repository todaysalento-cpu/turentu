import 'dotenv/config'; 
import { filterDisponibilita } from './services/search/engine/availability.engine.js';
import { CacheStore, loadCachesUltra } from './services/search/search.cache.js';

async function runTest() {
    try {
        console.log("🔄 Avvio sincronizzazione cache...");
        // Forza il caricamento per assicurarsi che i dati siano aggiornati
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

        // Casi di test configurati
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
                label: "TRATTA LOCALE (Area Matera/Bari)",
                richiesta: { 
                    coord: { lat: 40.66, lon: 16.60 }, 
                    coordDest: { lat: 40.67, lon: 16.61 }, 
                    posti_richiesti: 1,
                    start_datetime: nowIso 
                }
            },
            {
                label: "TRATTA LOCALE (Salento: Tricase -> Corsano)",
                richiesta: { 
                    coord: { lat: 39.9317, lon: 18.3582 }, 
                    coordDest: { lat: 39.9547, lon: 18.3753 }, 
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

            if (slots.length > 0) {
                slots.forEach(s => {
                    console.log(`🚗 Slot Valido: V:${s.veicolo_id} (Disponibile: ${s.disponibile})`);
                });
            }
        }

    } catch (error) {
        console.error("❌ Errore critico durante il test:", error);
    }
}

runTest();