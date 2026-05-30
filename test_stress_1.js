import { CacheStore, upsertCorsa, upsertVeicolo, upsertDisponibilita } from './services/search/search.cache.js';
import { filterDisponibilita } from './services/search/engine/availability.engine.js';
import { performance } from 'perf_hooks';
import ngeohash from 'ngeohash';

async function runStressTest() {
    console.log("🔥 Avvio Stress Test: Generazione dati sincronizzati...");

    const latBase = 45.4642;
    const lonBase = 9.1900;
    const targetHash = ngeohash.encode(latBase, lonBase, 4);
    
    // 1. Generazione 50.000 corse
    for (let i = 0; i < 50000; i++) {
        const isMatch = i === 49999;
        upsertCorsa({
            id: i,
            percorso_polyline: "or~nGe_wpA_@sA?k@G_@Cg@?a@A[?S?S?S?S?S?S",
            start_datetime: new Date().toISOString(),
            path_geohashes: [isMatch ? targetHash : "s000"],
            posti_totali: 4
        });
    }

    // 2. Generazione 5.000 veicoli e disponibilità
    for (let i = 0; i < 5000; i++) {
        const isMatch = i === 4999;
        // Inseriamo prima il veicolo
        upsertVeicolo({ 
            id: i, 
            lat: isMatch ? latBase : latBase + 2, 
            lon: isMatch ? lonBase : lonBase + 2 
        });
        // Inseriamo poi la disponibilità (così l'indice trova il veicolo)
        upsertDisponibilita({ 
            id: i, 
            veicolo_id: i, 
            start: "2026-05-30T00:00:00Z", 
            fine: "2026-05-30T23:59:00Z",
            disponibile: true 
        });
    }

    console.log(`✅ Dati caricati: ${CacheStore.corseCache.size} corse, ${CacheStore.disponibilitaCache.size} slot.`);

    // 3. Esecuzione Test
    // Simuliamo una richiesta "ora" (quindi compatibile con start/fine del test)
    const now = new Date();
    const richiesta = {
        coord: { lat: latBase, lon: lonBase },
        coordDest: { lat: latBase + 0.001, lon: lonBase + 0.001 },
        posti_richiesti: 1,
        start_datetime: now.toISOString()
    };

    console.log(`🚀 Esecuzione test... (Hash target: ${targetHash})`);
    const start = performance.now();
    
    const risultati = filterDisponibilita(
        richiesta, 
        CacheStore.veicoliCache, 
        CacheStore.disponibilitaCache, 
        CacheStore.corseCache
    );
    
    const end = performance.now();

    console.log("--------------------------------------------------");
    console.log(`⏱️ Tempo di esecuzione: ${(end - start).toFixed(4)} ms`);
    console.log(`📊 Corse trovate: ${risultati.corse.length}`);
    console.log(`🚗 Slot trovati: ${risultati.slots.length}`);
    
    if (risultati.corse.length > 0 && risultati.slots.length > 0) {
        console.log("✨ Test Successo: Indici spaziali e temporali funzionanti!");
    } else {
        console.log("⚠️ Test Fallito: Verificare la logica di filtering in availability.engine.js");
    }
}

runStressTest().catch(console.error);