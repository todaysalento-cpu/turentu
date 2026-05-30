import { filterDisponibilita } from './services/search/engine/availability.engine.js';

// Simulazione Cache
const numCorse = 50000;
const numVeicoli = 5000;

console.log(`🔥 Avvio Stress Test: Generazione ${numCorse} corse e ${numVeicoli} veicoli...`);

// 1. Genera dati finti
const corseCache = new Map();
for (let i = 0; i < numCorse; i++) {
    corseCache.set(i, {
        id: i,
        posti_totali: 50,
        picco_occupazione: Math.floor(Math.random() * 40),
        decodedCoords: [[15 + Math.random(), 41 + Math.random()], [15 + Math.random(), 41 + Math.random()]],
        bbox: { minLat: 40, maxLat: 42, minLon: 14, maxLon: 16 },
        fermate_pianificate: []
    });
}

const veicoliCache = new Map();
const disponibilitaCache = new Map();
for (let i = 0; i < numVeicoli; i++) {
    veicoliCache.set(i, { id: i, lat: 40 + Math.random(), lon: 15 + Math.random() });
    disponibilitaCache.set(i, { 
        veicolo_id: i, 
        start: "2026-05-30T08:00:00Z", 
        fine: "2026-05-30T20:00:00Z", 
        disponibile: true 
    });
}

// 2. Definizione Test
const richiesta = {
    coord: { lat: 41.5, lon: 15.5 },
    coordDest: { lat: 41.6, lon: 15.6 },
    posti_richiesti: 1,
    start_datetime: new Date().toISOString()
};

// 3. Esecuzione e Misurazione
console.log("🚀 Esecuzione test di carico...");
const start = performance.now();

const risultati = filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache);

const end = performance.now();

console.log("--------------------------------------------------");
console.log(`⏱️ Tempo di esecuzione: ${(end - start).toFixed(2)} ms`);
console.log(`📊 Corse trovate: ${risultati.corse.length}`);
console.log(`🚗 Slot trovati: ${risultati.slots.length}`);

if ((end - start) < 200) {
    console.log("✅ Performance eccellente (< 200ms)");
} else {
    console.log("⚠️ Performance degradata: considerare ulteriore ottimizzazione.");
}