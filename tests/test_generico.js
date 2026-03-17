// test_search.js
import { cercaSlotUltra } from './services/search/search.service.js';
import { loadCachesUltra } from './services/search/search.cache.js';

async function testSearch() {
  try {
    console.log('📦 Caricamento cache...');
    await loadCachesUltra();
    console.log('✅ Cache caricata');

    // Esempio richiesta
    const richiesta = {
      arrivo_datetime: new Date().toISOString(),
      posti_richiesti: 2,
      coord: { lat: 45.4642, lon: 9.1900 },       // Milano centro
      coordDest: { lat: 45.4781, lon: 9.2270 }    // destinazione vicina
    };

    console.log('⚡ Esecuzione ricerca...');
    const risultati = await cercaSlotUltra(richiesta);

    console.log(`✅ Trovati ${risultati.length} risultati`);

    risultati.forEach((r, i) => {
      console.log(`--- Risultato ${i + 1} ---`);
      console.log(`Tipo: ${r.tipo}`);
      console.log(`Veicolo: ${r.modello} | Posti richiesti: ${r.postiRichiesti ?? r.posti_richiesti}`);
      console.log(`Slot libero: ${r.slot_libero ?? r.slot_libero}`);
      console.log(`Distanza: ${r.distanzaKm} km | Prezzo: ${r.prezzo} €`);
      console.log(`Corse compatibili: ${r.corseCompatibili.length}`);
      console.log('----------------------');
    });

  } catch (err) {
    console.error('❌ Errore testSearch:', err);
  }
}

testSearch();
