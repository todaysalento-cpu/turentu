import { loadCachesUltra, cercaSlotUltra } from '../services/search/searchUltra.service.js';

async function testCorsaPrezzoUltra() {
  // Prima carichiamo le cache
  await loadCachesUltra();

  // Richiesta di esempio
  const richiesta = {
    coord: { lat: 41.8933203, lon: 12.4829321 },     // Origine
    coordDest: { lat: 45.4641943, lon: 9.1896346 },  // Destinazione
    posti_richiesti: 1,
    arrivo_datetime: '2026-01-30T12:00:00Z'
  };

  // Esegui ricerca slot/corse
  const risultati = await cercaSlotUltra(richiesta);

  console.log('=== Risultati Slot & Corse ===');
  risultati.forEach((r, i) => {
    console.log(`\nRisultato ${i + 1}`);
    console.log(`Veicolo ID: ${r.veicolo_id}`);
    console.log(`Modello: ${r.modello}`);
    console.log(`Servizi: ${r.servizi.join(', ') || 'Nessuno'}`);
    console.log(`Posti richiesti: ${r.posti_richiesti}`);
    console.log(`Prezzo: ${r.prezzo.toFixed(2)} €`);
    console.log(`Slot libero: ${r.slot_libero}`);
    if (!r.slot_libero) {
      console.log(`Corsa compatibile ID: ${r.corseCompatibili[0]?.id}`);
    }
  });

  console.log(`\nTotale risultati: ${risultati.length}`);
}

// Esegui test
testCorsaPrezzoUltra().catch(console.error);
