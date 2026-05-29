import { filterDisponibilita } from './services/search/engine/availability.engine.js';
import { performance } from 'perf_hooks';

async function runStressTest() {
  console.log("🔥 Avvio Stress Test: 10.000 corse in cache...");

  // Generiamo 10.000 corse simulate
  const corseCache = Array.from({ length: 10000 }, (_, i) => ({
    id: i,
    posti_totali: 4,
    picco_occupazione: 1,
    // Distribuiamo le corse su vari Geohash
    path_geohashes: [i % 2 === 0 ? 'u0nd9' : 'u0nd8'], 
    percorso_polyline: "y}w_GkrupA_c|@cewpA",
    fermate_pianificate: []
  }));

  const richiesta = {
    posti_richiesti: 1,
    coord: { lat: 45.4642, lon: 9.1900 },
    coordDest: { lat: 45.4781, lon: 9.2270 }
  };

  process.env.NODE_ENV = 'test'; // Bypass geometrico per velocità pura

  const start = performance.now();
  const { corse } = filterDisponibilita(richiesta, [], [], corseCache);
  const end = performance.now();

  console.log(`✅ Test completato.`);
  console.log(`⏱️ Tempo di esecuzione: ${(end - start).toFixed(2)} ms`);
  console.log(`📊 Corse trovate: ${corse.length}`);
  
  if ((end - start) < 200) {
    console.log("🚀 Performance eccellente (< 200ms)");
  } else {
    console.warn("⚠️ Performance lenta: ottimizzare il filtro Geohash");
  }
}

runStressTest();