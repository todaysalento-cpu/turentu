import { loadCachesUltra, cercaSlotUltra } from '../services/search/searchUltra.service.js';

async function testSearch() {
  try {
    // Carica cache veicoli e corse
    await loadCachesUltra();
    console.log('✅ Cache caricata correttamente.\n');

    // Input simulato: origine e destinazione
    const richiesta = {
      coord: { lat: 41.89100, lon: 12.49500 },        // origine
      destinazione: { lat: 41.89500, lon: 12.50000 }, // destinazione
      arrivo_datetime: '2026-01-28T10:00:00Z',
      posti_richiesti: 1,
      km: 1
    };

    // Esegui ricerca slot/corse
    const risultati = await cercaSlotUltra(richiesta);

    console.log('--- Risultati ricerca ---\n');

    risultati.forEach(r => {
      console.log(`Veicolo ID: ${r.veicolo_id}`);
      console.log(r.slot_libero ? 'Libero' : 'Condiviso');
      console.log(`Origine → Destinazione: ${r.coord.lat.toFixed(5)}, ${r.coord.lon.toFixed(5)} → ${
        r.corseCompatibili.length > 0
          ? `${r.corseCompatibili[0].dest_lat.toFixed(5)}, ${r.corseCompatibili[0].dest_lon.toFixed(5)}`
          : '???'
      }`);
      if (!r.slot_libero && r.corseCompatibili[0]) {
        console.log(`Partenza: ${new Date(r.corseCompatibili[0].start_datetime).toLocaleString()}`);
        console.log(`Arrivo: ${r.corseCompatibili[0].arrivo_datetime ? new Date(r.corseCompatibili[0].arrivo_datetime).toLocaleString() : 'stimato'}`);
      }
      console.log(`Distanza: ${r.distanzaKm.toFixed(2)} km`);
      console.log(`Prezzo: ${r.prezzo.toFixed(2)} €`);
      console.log('-------------------------\n');
    });

  } catch (err) {
    console.error('Errore test search:', err);
  }
}

testSearch();
