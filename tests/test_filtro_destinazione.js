import { loadCachesUltra, getDisponibilitaUltra } from '../services/search/searchUltra.service.js';

async function testFiltroDestinazione() {
  console.log('Caricamento cache...');
  await loadCachesUltra();
  console.log('✅ Cache caricata correttamente.\n');

  // --- Prima richiesta ---
  const richiesta1 = {
    coord: { lat: 41.891, lon: 12.495 },
    destinazione: { lat: 41.895, lon: 12.500 },
    posti_richiesti: 1,
    arrivo_datetime: '2026-01-28T09:00:00.000Z',
    km: 1
  };

  console.log('==== Richiesta 1 ===='); 
  console.log(`Origine: ${JSON.stringify(richiesta1.coord)} Destinazione: ${JSON.stringify(richiesta1.destinazione)}`);
  const { corse: corse1 } = getDisponibilitaUltra(richiesta1);
  corse1.forEach(c => {
    console.log(`Corsa ID: ${c.id}`);
    console.log(`  Origine: ${c.origine_lat}, ${c.origine_lon}`);
    console.log(`  Destinazione: ${c.dest_lat}, ${c.dest_lon}`);
    console.log(`  Geohash Origine: ${c.geohashOrigine}`);
    console.log(`  Geohash Destinazione: ${c.geohashDest}`);
    console.log(`  Posti disponibili: ${c.posti_disponibili}`);
    console.log('-------------------------');
  });

  // --- Seconda richiesta con destinazione diversa ---
  const richiesta2 = {
    coord: { lat: 41.891, lon: 12.495 },
    destinazione: { lat: 45.464, lon: 9.189 },
    posti_richiesti: 1,
    arrivo_datetime: '2026-01-28T09:00:00.000Z',
    km: 477
  };

  console.log('\n==== Richiesta 2 ===='); 
  console.log(`Origine: ${JSON.stringify(richiesta2.coord)} Destinazione: ${JSON.stringify(richiesta2.destinazione)}`);
  const { corse: corse2 } = getDisponibilitaUltra(richiesta2);
  corse2.forEach(c => {
    console.log(`Corsa ID: ${c.id}`);
    console.log(`  Origine: ${c.origine_lat}, ${c.origine_lon}`);
    console.log(`  Destinazione: ${c.dest_lat}, ${c.dest_lon}`);
    console.log(`  Geohash Origine: ${c.geohashOrigine}`);
    console.log(`  Geohash Destinazione: ${c.geohashDest}`);
    console.log(`  Posti disponibili: ${c.posti_disponibili}`);
    console.log('-------------------------');
  });
}

testFiltroDestinazione();
