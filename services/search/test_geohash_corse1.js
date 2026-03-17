// services/search/test_geohash_corse_compatibili.js
import 'dotenv/config';
import { cercaSlotUltra } from '../search/search.service.js';

async function testRichiesta() {
  try {
    // Richiesta esempio
    const richiesta = {
      coord: { lat: 45.4642, lon: 9.19 },       // Origine (Milano) → metti lat/lon di una corsa esistente
      coordDest: { lat: 45.4781, lon: 9.227 }, // Destinazione (Milano) → corrisponde a corsa nel DB
      start_datetime: new Date('2026-02-25T14:00:00.000Z').toISOString(), // coincide con corsa prenotabile
      posti_richiesti: 1
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
    const corse = risultati
      .filter(r => r.tipo === 'slot' && r.corseCompatibili && r.corseCompatibili.length > 0);

    console.log(`🏁 Corse compatibili trovate: ${corse.length}`);
    corse.forEach((r, i) => {
      r.corseCompatibili.forEach((c, j) => {
        console.log(`${i + 1}.${j + 1} Corsa ID: ${c.id}`);
        console.log(`   Veicolo ID: ${c.veicolo_id}`);
        console.log(`   Origine: ${c.origine_address} (${c.origine_lat}, ${c.origine_lon})`);
        console.log(`   Destinazione: ${c.destinazione_address} (${c.dest_lat}, ${c.dest_lon})`);
        console.log(`   Stato: ${c.stato}`);
        console.log(`   Prezzo fisso: ${c.prezzo_fisso}`);
        console.log(`   Posti disponibili: ${c.posti_disponibili}`);
        console.log('----------------------------------');
      });
    });

  } catch (err) {
    console.error('❌ Errore testRichiesta:', err);
  }
}

// Esegui test
testRichiesta();