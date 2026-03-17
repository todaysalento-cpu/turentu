// test_correlate.js
import { loadCachesUltra, getCorseCache } from './search.cache.js';
import ngeohash from 'ngeohash';

const GEOHASH_PRECISION = 5;

// Dati della richiesta
const richiesta = {
  coord: { lat: 41.8967, lon: 12.4822 },       // Roma
  coordDest: { lat: 40.8518, lon: 14.2681 },  // Napoli
  posti_richiesti: 1
};

(async () => {
  await loadCachesUltra(); // ✅ Carica la cache prima di usarla
  const corseCache = getCorseCache();
  if (!corseCache) {
    console.log('❌ Cache corse non caricata dopo loadCachesUltra');
    process.exit(1);
  }

  const richiestaHashOrig = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
  const richiestaHashDest = ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, GEOHASH_PRECISION);

  const corseCompatibili = corseCache.filter(c => {
    if (richiesta.posti_richiesti > c.posti_disponibili) return false;

    const origOk = [c.geohashOrigine, ...ngeohash.neighbors(c.geohashOrigine)]
      .includes(richiestaHashOrig);
    const destOk = [c.geohashDest, ...ngeohash.neighbors(c.geohashDest)]
      .includes(richiestaHashDest);

    return origOk && destOk;
  });

  console.log(`🏁 Corse compatibili con Roma → Napoli: ${corseCompatibili.length}`);
  console.log(corseCompatibili);
})();