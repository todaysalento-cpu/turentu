import { loadCachesUltra, cercaSlotUltra } from '../services/search/searchUltra.service.js';
import { pool } from '../db/db.js';
import { haversineDistance } from '../utils/geo.util.js'; // Aggiungi questa funzione se non esiste già per il calcolo della distanza

async function stressTestParallel(numRequests = 10000) {
  console.log('📦 Caricamento cache veicoli e corse...');
  await loadCachesUltra();
  console.log('✅ Cache caricata');

  // Genera richieste casuali basate su coordinate test
  const baseRequests = [
    { arrivo_datetime: '2026-01-28T10:00:00', km: 5, posti_richiesti: 1, coord: { lat: 41.891, lon: 12.495 }, coordDest: { lat: 45.4641943, lon: 9.1896346 } },
    { arrivo_datetime: '2026-01-28T11:00:00', km: 10, posti_richiesti: 2, coord: { lat: 41.892, lon: 12.496 }, coordDest: { lat: 45.4641943, lon: 9.1896346 } },
    { arrivo_datetime: '2026-01-28T12:00:00', km: 8, posti_richiesti: 1, coord: { lat: 41.893, lon: 12.497 }, coordDest: { lat: 45.4641943, lon: 9.1896346 } }
  ];

  // Crea un array di richieste ripetendo le richieste base per l'intero stress test
  const requests = Array.from({ length: numRequests }, (_, i) => baseRequests[i % baseRequests.length]);

  console.log(`⚡ Esecuzione stress test con ${numRequests} richieste parallele...`);
  const startTime = Date.now();

  // Invia tutte le richieste parallele
  const results = await Promise.all(requests.map(r => cercaSlotUltra(r)));

  const endTime = Date.now();
  const totalTime = endTime - startTime;
  const avgTime = totalTime / numRequests;

  console.log(`✅ Stress test completato`);
  console.log(`📊 Tempo totale: ${totalTime.toFixed(2)} ms`);
  console.log(`📊 Tempo medio per richiesta: ${avgTime.toFixed(2)} ms`);

  // Verifica la compatibilità della destinazione per ogni risultato
  results.forEach((result, index) => {
    console.log(`--- Risultato ${index + 1} ---`);
    result.forEach(item => {
      if (item.corseCompatibili.length > 0) {
        item.corseCompatibili.forEach(corsa => {
          // Verifica se la destinazione della corsa è compatibile con la destinazione della richiesta
          if (baseRequests[index].coordDest) {
            const distDestKm = haversineDistance(
              { lat: corsa.dest_lat, lon: corsa.dest_lon },
              baseRequests[index].coordDest
            );

            // Se la distanza è maggiore di 1 km, consideriamo la corsa non compatibile
            if (distDestKm > 1.0) {
              console.log(`❌ Corsa non compatibile con la destinazione. Distanza: ${distDestKm} km`);
            } else {
              console.log(`✅ Corsa compatibile con la destinazione. Distanza: ${distDestKm} km`);
            }
          } else {
            console.log(`⚠️ Nessuna destinazione fornita per la richiesta ${index + 1}, salto la verifica.`);
          }
        });
      } else {
        console.log(`🔍 Nessuna corsa compatibile trovata per il veicolo ${item.veicolo_id}.`);
      }
    });
  });

  // Opzionale: mostra il primo risultato per verifica
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
