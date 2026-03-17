// services/search/test_slots_corse.js
import { loadCachesUltra, getVeicoliCache, getDisponibilitaCache, getCorseCache } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import params from '../../config/params.js';

(async () => {
  // Assicura che le cache siano caricate
  await loadCachesUltra();

  const veicoliCache = getVeicoliCache();
  const disponibilitaCache = getDisponibilitaCache();
  const corseCache = getCorseCache();

  if (!veicoliCache || !disponibilitaCache || !corseCache) {
    console.error('❌ Cache non caricata');
    return;
  }

  console.log(`📦 VEICOLI CACHE: ${Object.keys(veicoliCache).length}`);
  console.log(`📦 DISPONIBILITA CACHE: ${disponibilitaCache.length}`);
  console.log(`📦 CORSE CACHE: ${corseCache.length}`);

  // Simula richiesta Roma -> Napoli
  const richiesta = {
    coord: { lat: 41.8967, lon: 12.4822 },      // Roma centro
    coordDest: { lat: 40.8518, lon: 14.2681 },  // Napoli centro
    localitaOrigine: 'Roma, RM, Italia',
    localitaDestinazione: 'Napoli, NA, Italia',
    start_datetime: new Date().toISOString(),
    posti_richiesti: 1
  };

  // Modifica un veicolo esistente per essere vicino alla richiesta
  const firstVeicoloId = Object.keys(veicoliCache)[0];
  veicoliCache[firstVeicoloId].lat = richiesta.coord.lat;
  veicoliCache[firstVeicoloId].lon = richiesta.coord.lon;
  veicoliCache[firstVeicoloId].geohash = 'sr2yk'; // geohash compatibile con Roma

  // Modifica disponibilità corrispondente
  const firstDisponibilita = disponibilitaCache.find(d => d.veicolo_id == firstVeicoloId);
  if (firstDisponibilita) {
    firstDisponibilita._distanzaKm = 0;
    firstDisponibilita.giorni_esclusi = [];
  }

  // Filtra slots e corse
  const { slots, corse } = filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache);

  console.log('🏁 Slots compatibili:', slots.length, slots);
  console.log('🏁 Corse compatibili:', corse.length, corse);
})();