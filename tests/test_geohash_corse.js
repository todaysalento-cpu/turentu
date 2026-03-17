// services/search/test_geohash_corse_compatibili.js
import 'dotenv/config';
import { cercaSlotUltra } from '.services/search/search.service.js';

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

    // =========================
    // Slot
    // =========================
    const slots = risultati.filter(r => r.tipo === 'slot');
    console.log(`✅ Slot trovati: ${slots.length}`);
    slots.forEach((r, i) => {
      console.log(`${i + 1}. Tipo: ${r.tipo}`);
      console.log(`   Veicolo ID: ${r.veicolo_id}`);
      console.log(`   Modello: ${r.modello ?? 'N/D'}`);
      console.log(`   Servizi: ${Array.isArray(r.servizi) ? r.servizi.join(', ') : r.servizi}`);
      console.log(`   Stato: ${r.stato}`);
      console.log(`   Prezzo: ${r.prezzo}`);
      console.log(`   Coord Origine: ${r.coordOrigine.lat}, ${r.coordOrigine.lon}`);
      console.log(`   Coord Destinazione: ${r.coordDestinazione.lat}, ${r.coordDestinazione.lon}`);
      console.log('----------------------------------');
    });

    // =========================
    // Corse compatibili
    // =========================
    const corse = risultati.filter(r => r.tipo === 'corsa' && r.corseCompatibili.length > 0);
    console.log(`🏁 Corse compatibili trovate: ${corse.length}`);
    corse.forEach((r, i) => {
      console.log(`${i + 1}. Tipo: ${r.tipo}`);
      console.log(`   Veicolo ID: ${r.veicolo_id}`);
      console.log(`   Modello: ${r.modello ?? 'N/D'}`);
      console.log(`   Servizi: ${Array.isArray(r.servizi) ? r.servizi.join(', ') : r.servizi}`);
      console.log(`   Stato: ${r.stato}`);
      console.log(`   Prezzo: ${r.prezzo}`);
      console.log(`   Coord Origine: ${r.coordOrigine.lat}, ${r.coordOrigine.lon}`);
      console.log(`   Coord Destinazione: ${r.coordDestinazione.lat}, ${r.coordDestinazione.lon}`);
      console.log('----------------------------------');
    });

  } catch (err) {
    console.error('❌ Errore testRichiesta:', err);
  }
}

// Esegui test
testRichiesta();
