import { loadCachesUltra, cercaSlotUltra } from '../services/search/searchUltra.service.js';

async function stressTest() {
  console.log('📦 Caricamento cache...');
  await loadCachesUltra();
  console.log('✅ Cache caricata');

  const NUM_RICHIESTE = 10000;
  const richieste = [];

  // Genera richieste casuali
  for (let i = 0; i < NUM_RICHIESTE; i++) {
    richieste.push({
      coord: { lat: 41.891 + Math.random() * 0.01, lon: 12.495 + Math.random() * 0.01 },
      arrivo_datetime: new Date(Date.now() + Math.random() * 3600 * 1000).toISOString(),
      km: Math.floor(Math.random() * 20) + 1,
      posti_richiesti: 1
    });
  }

  console.log(`⚡ Esecuzione stress test con ${NUM_RICHIESTE} richieste...`);
  const start = Date.now();

  const results = await Promise.all(richieste.map(r => cercaSlotUltra(r)));
  const totalTime = Date.now() - start;

  // Statistiche rapide
  let slotLiberi = 0;
  let corsePrenotabili = 0;
  const prezzi = [];

  results.flat().forEach(r => {
    if (r.slot_libero) slotLiberi++;
    if (!r.slot_libero && r.corseCompatibili.length > 0) corsePrenotabili++;
    prezzi.push(r.prezzo);
  });

  console.log('✅ Stress test completato');
  console.log(`📊 Tempo totale: ${totalTime} ms`);
  console.log(`📊 Tempo medio per richiesta: ${(totalTime / NUM_RICHIESTE).toFixed(5)} ms`);
  console.log(`📊 Slot liberi: ${slotLiberi}`);
  console.log(`📊 Corse prenotabili: ${corsePrenotabili}`);
  console.log(`📊 Prezzo min: €${Math.min(...prezzi)}, max: €${Math.max(...prezzi)}`);
}

stressTest().catch(console.error);

