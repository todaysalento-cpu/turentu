// services/search/test_debug_corse.js
import { loadCachesUltra, getVeicoliCache, getDisponibilitaCache, getCorseCache } from './search.cache.js';
import { haversineDistance } from '../../utils/geo.util.js';
import ngeohash from 'ngeohash';
import params from '../../config/params.js';

(async () => {
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

  const richiesta = {
    coord: { lat: 41.8967, lon: 12.4822 },      // Roma centro
    coordDest: { lat: 40.8518, lon: 14.2681 },  // Napoli centro
    localitaOrigine: 'Roma, RM, Italia',
    localitaDestinazione: 'Napoli, NA, Italia',
    start_datetime: new Date().toISOString(),
    posti_richiesti: 1
  };

  // Debug corse compatibili
  const compatibili = [];
  for (const c of corseCache) {
    let motivo = null;

    if (richiesta.posti_richiesti > c.posti_disponibili) {
      motivo = 'posti insufficienti';
    }

    if (richiesta.coord && richiesta.coordDest) {
      const origOk = [c.geohashOrigine, ...ngeohash.neighbors(c.geohashOrigine)].includes(
        ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, 5)
      );
      const destOk = [c.geohashDest, ...ngeohash.neighbors(c.geohashDest)].includes(
        ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, 5)
      );
      if (!origOk) motivo = (motivo ? motivo + ', ' : '') + 'geohash origine non compatibile';
      if (!destOk) motivo = (motivo ? motivo + ', ' : '') + 'geohash destinazione non compatibile';
    }

    if (!motivo) {
      compatibili.push(c);
    } else {
      console.log(`❌ Corsa ${c.id} scartata: ${motivo}`);
    }
  }

  console.log('🏁 Corse compatibili:', compatibili.length, compatibili);
})();