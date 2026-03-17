// services/search/test_generico.js
import 'dotenv/config';
import { cercaSlotUltra } from './search.service.js';

async function testRichiesta() {
  try {
    // Richiesta esempio
    const richiesta = {
      coord: { lat: 41.8933203, lon: 12.4829321 },       // Origine (Roma)
      coordDest: { lat: 45.4641943, lon: 9.1896346 },    // Destinazione (Milano)
      arrivo_datetime: new Date().toISOString(),         // Data/ora richiesta
      posti_richiesti: 2                                  // Numero posti richiesti
    };

    console.log('📦 Caricamento cache e ricerca...');
    const risultati = await cercaSlotUltra(richiesta);

    console.log('✅ Risultati trovati:');
    risultati.forEach((r, i) => {
      console.log(`${i + 1}. Tipo: ${r.tipo}`);
      console.log(`   Veicolo ID: ${r.veicolo_id}`);
      console.log(`   Modello: ${r.modello}`);
      console.log(`   Servizi: ${r.servizi?.join(', ') || 'N/D'}`);
      console.log(`   Stato: ${r.stato}`);
      console.log(`   Prezzo: ${r.prezzo}`);
      console.log(`   Coord Origine: ${r.coordOrigine?.lat}, ${r.coordOrigine?.lon}`);
      console.log(`   Coord Destinazione: ${r.coordDestinazione?.lat}, ${r.coordDestinazione?.lon}`);
      console.log('----------------------------------');
    });

  } catch (err) {
    console.error('❌ Errore testRichiesta:', err);
  }
}

// Esegui test
testRichiesta();
