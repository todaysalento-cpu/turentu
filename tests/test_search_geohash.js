import { populateTestData } from '../utils/populateTestData.js'; // lo script di popolamento
import { loadCachesUltra, cercaSlotUltra } from '../services/search/searchUltra.service.js';

async function testSearchUltra() {
  try {
    console.log('🚀 Popolamento dati di test...');
    await populateTestData();

    console.log('📦 Caricamento cache veicoli e corse...');
    await loadCachesUltra();

    // =====================
    // Simula una richiesta
    // =====================
    const richiesta = {
      arrivo_datetime: '2026-01-28T14:15:00',
      posti_richiesti: 2,
      km: 5, // distanza stimata
      coord: { lat: 41.891, lon: 12.495 } // coordinate richieste
    };

    console.log('🔍 Esecuzione ricerca ultra...');
    const risultati = await cercaSlotUltra(richiesta);

    console.log('--- Risultati ricerca ---');
    risultati.forEach((r, i) => {
      console.log(`--- Risultato ${i + 1} ---`);
      console.log(`Veicolo: ${r.veicolo_id}`);
      console.log(`Stato: ${r.stato}`);
      console.log(`Slot libero: ${r.slot_libero}`);
      console.log(`Distanza: ${r.distanzaKm.toFixed(2)} km`);
      console.log(`Prezzo stimato: €${r.prezzo.toFixed(2)}`);
      if (r.corseCompatibili.length) {
        console.log(`Corse compatibili: ${r.corseCompatibili.map(c => c.id).join(', ')}`);
      }
      console.log(`Coordinate veicolo: lat ${r.coord.lat}, lon ${r.coord.lon}`);
    });

    console.log('✅ Test completato');
  } catch (err) {
    console.error('❌ Errore nel test searchUltra:', err);
  }
}

// Esecuzione test
testSearchUltra();
