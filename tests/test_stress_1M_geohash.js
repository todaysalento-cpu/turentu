import { loadCachesUltra, cercaSlotUltra } from '../services/search/searchUltra.service.js';

const NUM_REQUESTS = 1_000_000;
const BATCH_SIZE = 10_000;

async function stressTestUltra() {
  console.log('📦 Caricamento cache veicoli e corse...');
  await loadCachesUltra();
  console.log('✅ Cache caricata');

  console.log(`⚡ Stress test con ${NUM_REQUESTS.toLocaleString()} richieste parallele...`);

  let slotLiberi = 0;
  let corsePrenotabili = 0;
  let prezzoMin = Infinity;
  let prezzoMax = -Infinity;

  const startTime = Date.now();

  for (let i = 0; i < NUM_REQUESTS; i += BATCH_SIZE) {
    const batch = Array.from({ length: BATCH_SIZE }, () => ({
      km: 10,
      posti_richiesti: 1,
      arrivo_datetime: new Date().toISOString(),
      coord: { lat: 41.891, lon: 12.495 }
    }));

    const batchResults = await Promise.all(batch.map(cercaSlotUltra));

    // Aggiorna min/max e conteggi senza salvare tutto
    batchResults.flat().forEach(r => {
      if (r.slot_libero) slotLiberi++;
      else corsePrenotabili++;

      if (r.prezzo < prezzoMin) prezzoMin = r.prezzo;
      if (r.prezzo > prezzoMax) prezzoMax = r.prezzo;
    });

    console.log(`🔹 Elaborate richieste: ${(i + BATCH_SIZE).toLocaleString()} / ${NUM_REQUESTS.toLocaleString()}`);
  }

  const endTime = Date.now();
  console.log('✅ Stress test completato');
  console.log(`📊 Tempo totale: ${((endTime - startTime) / 1000).toFixed(3)} s`);
  console.log(`📊 Tempo medio per richiesta: ${((endTime - startTime) / NUM_REQUESTS).toFixed(6)} ms`);
  console.log(`📊 Slot liberi: ${slotLiberi}`);
  console.log(`📊 Corse prenotabili: ${corsePrenotabili}`);
  console.log(`📊 Prezzo min: €${prezzoMin}, max: €${prezzoMax}`);
}

stressTestUltra().catch(err => console.error('❌ Errore stress test:', err));
