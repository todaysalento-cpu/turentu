import { filterDisponibilita } from './services/search/engine/availability.engine.js';
import { performance } from 'perf_hooks';

async function runAdvancedStressTest() {
  const NUM_CORSE = 50000;
  console.log(`🚀 Avvio Stress Test Avanzato: ${NUM_CORSE} corse...`);

  // Generiamo un carico realistico:
  // 1. Corse vicine (geohash u0nd9) - dovrebbero passare il primo filtro
  // 2. Corse sature (picco > capacità) - dovrebbero essere scartate per capacità
  const corseCache = Array.from({ length: NUM_CORSE }, (_, i) => ({
    id: i,
    posti_totali: 4,
    picco_occupazione: i % 5 === 0 ? 3 : 0, // 20% delle corse sono sature
    path_geohashes: i % 2 === 0 ? ['u0nd9'] : ['u0aa1'], // 50% filtrabili per hash
    percorso_polyline: "y}w_GkrupA_c|@cewpA",
    fermate_pianificate: []
  }));

  const richiesta = {
    posti_richiesti: 2,
    coord: { lat: 45.4642, lon: 9.1900 },
    coordDest: { lat: 45.4781, lon: 9.2270 }
  };

  // TEST 1: Con filtro geometrico ATTIVO (Simulazione Produzione)
  process.env.NODE_ENV = 'production'; 
  
  const start = performance.now();
  const { corse } = filterDisponibilita(richiesta, [], [], corseCache);
  const end = performance.now();

  console.log(`⏱️ Tempo di esecuzione (Produzione): ${(end - start).toFixed(2)} ms`);
  console.log(`📊 Corse rimaste dopo i filtri: ${corse.length}`);
  console.log("--------------------------------------------------");
  
  // Analisi dei colli di bottiglia
  const corseSature = corseCache.filter(c => (c.picco_occupazione + 2) > 4).length;
  console.log(`ℹ️ Corse scartate per capacità (teorico): ${corseSature}`);
  console.log(`ℹ️ Corse scartate per Geohash (teorico): ~${NUM_CORSE / 2}`);
}

runAdvancedStressTest();