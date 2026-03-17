import { loadCachesUltra, getDisponibilitaUltra } from '../services/search/searchUltra.service.js';
import ngeohash from 'ngeohash';

async function test() {
  console.log('Caricamento cache...');
  await loadCachesUltra();
  console.log('✅ Cache caricata correttamente.\n');

  const richieste = [
    { coord: { lat: 41.891, lon: 12.495 }, destinazione: { lat: 41.895, lon: 12.5 }, posti_richiesti: 1 },
    { coord: { lat: 41.891, lon: 12.495 }, destinazione: { lat: 45.464, lon: 9.189 }, posti_richiesti: 1 },
  ];

  richieste.forEach((r, idx) => {
    console.log(`==== Richiesta ${idx + 1} ====`);
    console.log('Origine:', r.coord, 'Destinazione:', r.destinazione);

    const { corse } = getDisponibilitaUltra(r);

    if (corse.length === 0) {
      console.log('Nessuna corsa compatibile trovata.\n');
    } else {
      corse.forEach(c => {
        console.log(`Corsa ID: ${c.id}`);
        console.log(`  Origine: ${c.origine_lat}, ${c.origine_lon}`);
        console.log(`  Destinazione: ${c.dest_lat}, ${c.dest_lon}`);
        console.log(`  Geohash Origine: ${c.geohashOrigine}`);
        console.log(`  Geohash Destinazione: ${c.geohashDest}`);
        console.log(`  Posti disponibili: ${c.posti_disponibili}`);
        console.log('-------------------------');
      });
      console.log('\n');
    }
  });
}

test();

