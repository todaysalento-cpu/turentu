import { loadCachesUltra, cercaSlotUltra } from '../services/search/searchUltra.service.js';
import { pool } from '../db/db.js';

async function stressTestParallel(numRequests = 10000) {
  console.log('📦 Caricamento cache veicoli e corse...');
  await loadCachesUltra();
  console.log('✅ Cache caricata');

  // Genera richieste casuali basate su coordinate test
  const baseRequests = [
    { arrivo_datetime: '2026-01-28T10:00:00', km: 5, posti_richiesti: 1, coord: { lat: 41.891, lon: 12.495 } },
    { arrivo_datetime: '2026-01-28T11:00:00', km: 10, posti_richiesti: 2, coord: { lat: 41.892, lon: 12.496 } },
    { arrivo_datetime: '2026-01-28T12:00:00', km: 8, posti_richiesti: 1, coord: { lat: 41.893, lon: 12.497 } }
  ];

  const requests = Array.from({ length: numRequests }, (_, i) => baseRequests[i % baseRequests.length]);

  console.log(`⚡ Esecuzione stress test con ${numRequests} richieste parallele...`);
  const startTime = Date.now();

  const results = await Promise.all(requests.map(r => cercaSlotUltra(r)));

  const endTime = Date.now();
  const totalTime = endTime - startTime;
  const avgTime = totalTime / numRequests;

  console.log(`✅ Stress test completato`);
  console.log(`📊 Tempo totale: ${totalTime.toFixed(2)} ms`);
  console.log(`📊 Tempo medio per richiesta: ${avgTime.toFixed(2)} ms`);

  // Opzionale: verifica risultati sample
  console.log('--- Esempio risultato 1 ---');
  console.log(results[0]);
}

// Esegui stress test
stressTestParallel().then(() => {
  console.log('🎯 Fine test');
  pool.end();
}).catch(err => {
  console.error('❌ Errore stress test:', err);
  pool.end();
});
