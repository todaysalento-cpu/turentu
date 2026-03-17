// services/search/test_all_field.js
import 'dotenv/config';
import {
  loadCachesUltra,
  veicoliCache,
  disponibilitaCache,
  corseCache
} from './search.cache.js';

import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';

function printCoord(label, c) {
  if (!c) return console.log(`   ${label}: N/D`);
  console.log(`   ${label}: ${c.lat}, ${c.lon}`);
}

async function testAllField() {
  console.log('📦 Caricamento cache e ricerca...');
  await loadCachesUltra();

  if (!veicoliCache || !disponibilitaCache || !corseCache) {
    throw new Error('❌ Cache non inizializzate');
  }

  const richiesta = {
    coord: { lat: 41.89332, lon: 12.48293 },      // Roma
    coordDest: { lat: 45.46419, lon: 9.18963 },  // Milano
    start_datetime: new Date().toISOString(),
    posti_richiesti: 2
  };

  const { slots, corse } = filterDisponibilita(
    richiesta,
    veicoliCache,
    disponibilitaCache,
    corseCache
  );

  const risultati = await formatResults(
    richiesta,
    slots,
    corse,
    veicoliCache
  );

  console.log(`✅ Risultati trovati: ${risultati.length}\n`);

  risultati.forEach((r, i) => {
    console.log(`================ RISULTATO ${i + 1} =================`);
    console.log(`Tipo: ${r.tipo}`);
    console.log(`ID: ${r.id}`);
    console.log(`Veicolo ID: ${r.veicolo_id}`);
    console.log(`Modello: ${r.modello}`);
    console.log(`Servizi: ${JSON.stringify(r.servizi)}`);
    console.log(`Stato: ${r.stato}`);

    printCoord('Origine', r.coordOrigine);
    printCoord('Destinazione', r.coordDestinazione);

    console.log(`Ora partenza: ${r.oraPartenza}`);
    console.log(`Ora arrivo: ${r.oraArrivo}`);
    console.log(`Durata (ms): ${r.durataMs}`);
    console.log(`Distanza (km): ${r.distanzaKm}`);
    console.log(`Prezzo: ${r.prezzo}`);

    if (r.tipo === 'slot') {
      console.log(`Posti totali: ${r.postiTotali}`);
      console.log(`Posti richiesti: ${r.postiRichiesti}`);
      console.log(`Euro/km: ${r.euro_km}`);
    }

    if (r.tipo === 'corsa') {
      console.log(`Corse compatibili: ${r.corseCompatibili.length}`);
      const c = r.corseCompatibili[0];
      if (c) {
        console.log('--- DATI CORSA REALE ---');
        console.log(`Origine reale: ${c.origine_lat}, ${c.origine_lon}`);
        console.log(`Dest reale: ${c.dest_lat}, ${c.dest_lon}`);
        console.log(`Start datetime: ${c.start_datetime}`);
        console.log(`Durata (s): ${c.durata}`);
        console.log(`Posti disponibili: ${c.posti_disponibili}`);
      }
    }

    console.log('===============================================\n');
  });
}

testAllField().catch(err => {
  console.error('💥 Errore test:', err);
});
