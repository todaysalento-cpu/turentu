import { loadCachesUltra, cercaSlotUltra } from '../services/search/searchUltra.service.js';

async function testCache() {
  console.log('📦 Caricamento cache...');
  await loadCachesUltra();

  console.log('🔍 Test ricerca ultra rapida...');

  const richiesta = {
    coord: { lat: 41.891, lon: 12.495 },
    arrivo_datetime: new Date().toISOString(),
    km: 5,
    posti_richiesti: 1
  };

  try {
    // ⚡ await perché cercaSlotUltra è ora async
    const results = await cercaSlotUltra(richiesta);

    console.log('--- Risultati ---');
    results.forEach((r, i) => {
      console.log(`Risultato ${i + 1}: veicolo ${r.veicolo_id}, stato ${r.stato}, distanza ${r.distanzaKm.toFixed(2)} km, prezzo ${r.prezzo}`);
    });

    console.log('✅ Test completato');
  } catch (err) {
    console.error('❌ Errore nel test:', err);
  }
}

testCache();
