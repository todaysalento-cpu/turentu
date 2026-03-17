// tests/test_stress_100000_geohash_no_populate.js
import { loadCachesUltra, cercaSlotUltra } from '../services/search/searchUltra.service.js';

async function stressTestUltraBig(numRequests = 100000) {
  console.log('📦 Caricamento cache veicoli e corse...');
  await loadCachesUltra();
  console.log('✅ Cache caricata');

  console.log(`⚡ Esecuzione stress test con ${numRequests} richieste parallele...`);

  // Genera richieste casuali
  const richieste = Array.from({ length: numRequests }, () => ({
    km: Math.floor(Math.random() * 20) + 1,
    posti_richiesti: Math.floor(Math.random() * 3) + 1,
    arrivo_datetime: new Date().toISOString(),
    coord: {
      lat: 41.891 + Math.random() * 0.01,
      lon: 12.495 + Math.random() * 0.01,
    },
  }));

  const startTime = Date.now();

  let minPrezzo = Infinity;
  let maxPrezzo = -Infinity;
  let totalSlots = 0;
  let totalCorse = 0;

  for (let i = 0; i < richieste.length; i++) {
    const results = await cercaSlotUltra(richieste[i]);

    for (const r of results) {
      if (r.prezzo < minPrezzo) minPrezzo = r.prezzo;
      if (r.prezzo > maxPrezzo) maxPrezzo = r.prezzo;
      if (r.slot_libero) totalSlots++;
      if (!r.slot_libero) totalCorse++;
    }

    // Stampa avanzamento ogni 10.000 richieste
    if ((i + 1) % 10000 === 0) {
      console.log(`🔹 Elaborate richieste: ${i + 1} / ${numRequests}`);
    }
  }

  const endTime = Date.now();

  console.log('✅ Stress test completato');
  console.log(`📊 Tempo totale: ${endTime - startTime} ms`);
  console.log(`📊 Tempo medio per richiesta: ${(endTime - startTime) / numRequests} ms`);
  console.log(`📊 Slot liberi: ${totalSlots}`);
  console.log(`📊 Corse prenotabili: ${totalCorse}`);
  console.log(`📊 Prezzo min: €${minPrezzo.toFixed(2)}, max: €${maxPrezzo.toFixed(2)}`);
}

// Esegui test
stressTestUltraBig().catch(err => console.error('❌ Errore stress test:', err));
