import { cercaSlotUltra, loadCachesUltra } from '../services/search/searchUltra.service.js';

async function testCorsaDestinazioneModificata() {
  // Prima di tutto carichiamo le cache
  await loadCachesUltra();

  // Dati della richiesta identica a quella nel database
  const richiesta = {
    coord: { lat: 41.8933203, lon: 12.4829321 }, // Milano (origine)
    coordDest: { lat: 45.4641943, lon: 9.1896346 }, // Lecce (destinazione)
    posti_richiesti: 1,
    arrivo_datetime: '2026-01-30T12:00:00Z',
    km: 100 // La distanza stimata
  };

  try {
    const risultati = await cercaSlotUltra(richiesta);

    console.log('Richiesta:', richiesta);
    console.log('Risultati corse compatibili:', risultati);

    if (risultati.length > 0) {
      risultati.forEach(slot => {
        console.log('Slot trovato:');
        console.log(`  Veicolo ID: ${slot.veicolo_id}`);
        console.log(`  Coordinata di partenza (origine):`, slot.coord);
        console.log(`  Distanza slot (km):`, slot.distanzaKm);

        if (slot.corseCompatibili.length > 0) {
          slot.corseCompatibili.forEach(corsa => {
            console.log('  Corsa compatibile trovata:');
            console.log(`    Corsa ID: ${corsa.id}`);
            console.log(`    Origine: ${corsa.origine_lat}, ${corsa.origine_lon}`);
            console.log(`    Destinazione: ${corsa.dest_lat}, ${corsa.dest_lon}`);
            console.log(`    Prezzo: ${corsa.prezzo ?? '-'}`);
            console.log(`    Stato: ${corsa.stato ?? '-'}`);
            console.log(`    Distanza corsa: ${corsa.distanza ?? '-'}`);
          });
        } else {
          console.log('  Slot libero (nessuna corsa compatibile).');
        }
      });
      console.log('Test passato: corse compatibili trovate come previsto.');
    } else {
      console.log('Test fallito: nessuna corsa compatibile trovata, ma ci si aspettava di trovarne.');
    }
  } catch (error) {
    console.error('Errore nella ricerca delle corse:', error);
  }
}

testCorsaDestinazioneModificata();
