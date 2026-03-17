import { loadCachesUltra, getDisponibilitaUltra } from '../services/search/searchUltra.service.js';

// Esempi di richieste diverse
const richiesteTest = [
  {
    posti_richiesti: 1,
    arrivo_datetime: '2026-01-28T09:00:00.000Z',
    coord: { lat: 41.891, lon: 12.495 },           // origine
    destinazione: { lat: 41.895, lon: 12.500 }     // destinazione
  },
  {
    posti_richiesti: 1,
    arrivo_datetime: '2026-01-28T09:00:00.000Z',
    coord: { lat: 41.891, lon: 12.495 },           // stessa origine
    destinazione: { lat: 45.464, lon: 9.189 }      // destinazione diversa
  }
];

async function testFiltri() {
  console.log("Caricamento cache...");
  await loadCachesUltra();
  console.log("✅ Cache caricata correttamente.\n");

  for (const richiesta of richiesteTest) {
    console.log("==== Nuova richiesta ====");
    console.log("Origine:", richiesta.coord, "Destinazione:", richiesta.destinazione);

    const { corse } = getDisponibilitaUltra(richiesta);

    if (corse.length === 0) {
      console.log("⚠️ Nessuna corsa compatibile trovata.\n");
      continue;
    }

    corse.forEach(c => {
      console.log(`Corsa ID: ${c.id}`);
      console.log(`  Origine: ${c.origine_lat}, ${c.origine_lon}`);
      console.log(`  Destinazione: ${c.dest_lat}, ${c.dest_lon}`);
      console.log(`  Geohash Origine: ${c.geohashOrigine}`);
      console.log(`  Geohash Destinazione: ${c.geohashDest}`);
      console.log(`  Posti disponibili: ${c.posti_disponibili}`);
      console.log('-------------------------');
    });
    console.log("\n");
  }
}

testFiltri().catch(err => console.error(err));
