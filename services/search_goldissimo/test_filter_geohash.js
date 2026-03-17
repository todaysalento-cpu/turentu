// services/search/test_filter_geohash.js
import 'dotenv/config';
import { loadCachesUltra, veicoliCache, disponibilitaCache, corseCache } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';

async function testFilterGeohash() {
  await loadCachesUltra();

  const richiesta = {
    coord: { lat: 41.89332, lon: 12.48293 },        // Roma centro
    coordDest: { lat: 45.4642, lon: 9.18963 },     // Milano centro
    arrivo_datetime: new Date().toISOString(),
    posti_richiesti: 2
  };

  const { slots, corse } = filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache);

  console.log('🏁 Slots compatibili:', slots.length);
  slots.forEach(s => {
    const v = veicoliCache[s.veicolo_id];
    console.log(`- Slot Veicolo ${v.modello}, Coord: ${richiesta.coord.lat},${richiesta.coord.lon}`);
  });

  console.log('🏁 Corse compatibili:', corse.length);
  corse.forEach(c => {
    const v = veicoliCache[c.veicolo_id];
    console.log(`- Corsa Veicolo ${v.modello}`);
    console.log(`  Origine richiesta: ${richiesta.coord.lat},${richiesta.coord.lon}`);
    console.log(`  Origine corsa reale: ${c.origine_lat},${c.origine_lon}`);
    console.log(`  Dest richiesta: ${richiesta.coordDest.lat},${richiesta.coordDest.lon}`);
    console.log(`  Dest corsa reale: ${c.dest_lat},${c.dest_lon}`);
    console.log('----------------------------');
  });
}

testFilterGeohash();
