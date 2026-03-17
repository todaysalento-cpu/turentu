// services/search/test_slots_corse_roma_napoli.js
import { loadCachesUltra, getVeicoliCache, getDisponibilitaCache, getCorseCache } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import ngeohash from 'ngeohash';

(async () => {
  // ==================== CARICA CACHE ====================
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

  // ==================== RICHIESTA ====================
  const richiesta = {
    coord: { lat: 41.8967, lon: 12.4822 },      // Roma centro
    coordDest: { lat: 40.8518, lon: 14.2681 },  // Napoli centro
    localitaOrigine: 'Roma, RM, Italia',
    localitaDestinazione: 'Napoli, NA, Italia',
    start_datetime: new Date().toISOString(),
    posti_richiesti: 1
  };

  const GEOHASH_PRECISION = 5;

  // ==================== MODIFICA VEICOLO ====================
  const firstVeicoloId = Object.keys(veicoliCache)[0];
  veicoliCache[firstVeicoloId].lat = richiesta.coord.lat;
  veicoliCache[firstVeicoloId].lon = richiesta.coord.lon;
  veicoliCache[firstVeicoloId].geohash = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);

  // ==================== MODIFICA DISPONIBILITA ====================
  const firstDisponibilita = disponibilitaCache.find(d => d.veicolo_id == firstVeicoloId);
  if (firstDisponibilita) {
    firstDisponibilita._distanzaKm = 0;
    firstDisponibilita.giorni_esclusi = [];
  }

  // ==================== MODIFICA CORSA ====================
  const firstCorsa = corseCache[0];
  firstCorsa.geohashOrigine = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
  firstCorsa.geohashDest = ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, GEOHASH_PRECISION);
  firstCorsa.posti_disponibili = 3;
  firstCorsa.tipo_corsa = 'condivisa';
  firstCorsa.stato = 'libero';
  firstCorsa.start_datetime = new Date().toISOString();
  firstCorsa.durata = 7200; // 2 ore

  // ==================== FILTRO ====================
  const { slots, corse } = filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache);

  console.log('🏁 Slots compatibili:', slots.length, slots);
  console.log('🏁 Corse compatibili:', corse.length, corse);

})();