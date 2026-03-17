// services/search/test_backend_real.js
import { loadCachesUltra, getVeicoliCache, getDisponibilitaCache, getCorseCache } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';

(async () => {
  // Carica cache
  await loadCachesUltra();

  const veicoliCache = getVeicoliCache();
  const disponibilitaCache = getDisponibilitaCache();
  const corseCache = getCorseCache();

  if (!veicoliCache || !disponibilitaCache || !corseCache) {
    console.error('❌ Cache non caricata correttamente');
    return;
  }

  console.log(`📦 VEICOLI CACHE: ${Object.keys(veicoliCache).length}`);
  console.log(`📦 DISPONIBILITA CACHE: ${disponibilitaCache.length}`);
  console.log(`📦 CORSE CACHE: ${corseCache.length}`);
  console.log('📦 Esempio corsa:', corseCache[0]);

  // Richiesta esempio Roma -> Napoli
  const richiesta = {
    coord: { lat: 41.8967, lon: 12.4822 },      // Roma centro
    coordDest: { lat: 40.8518, lon: 14.2681 },  // Napoli centro
    localitaOrigine: 'Roma, RM, Italia',
    localitaDestinazione: 'Napoli, NA, Italia',
    start_datetime: new Date().toISOString(),
    posti_richiesti: 1
  };

  // Filtra slots e corse senza modifiche manuali
  const { slots, corse } = filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache);

  console.log('🏁 Slots compatibili:', slots.length, slots);
  console.log('🏁 Corse compatibili:', corse.length, corse);
})();