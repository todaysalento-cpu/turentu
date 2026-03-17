import { cercaSlotUltra, loadCachesUltra } from '../services/search/searchUltra.service.js';
import { pool } from '../db/db.js';

async function testCorsaCompatibilePrezzoSenzaKm() {
  await loadCachesUltra();

  const richiesta = {
    coord: { lat: 41.8933203, lon: 12.4829321 },   // Origine
    coordDest: { lat: 45.4641943, lon: 9.1896346 }, // Destinazione
    posti_richiesti: 1,
    arrivo_datetime: '2026-01-30T12:00:00Z'
    // Niente "km": vogliamo che prenda la distanza dalla corsa
  };

  try {
    const risultati = await cercaSlotUltra(richiesta);

    console.log('Richiesta:', richiesta);
    console.log('Risultati corse compatibili:', risultati);

    risultati.forEach(slot => {
      if (slot.slot_libero) {
        console.log(`Slot libero: Veicolo ${slot.veicolo_id}`);
        console.log(`  Prezzo: ${slot.prezzo.toFixed(2)} €`);
        console.log(`  Distanza: ${slot.distanzaKm.toFixed(2)} km`);
      } else {
        const corsa = slot.corseCompatibili[0];
        const kmPerPrezzo = corsa.distanza; // usa la distanza della corsa
        const statoPrezzo = corsa.stato === 'prenotabile' ? 'condiviso' : corsa.stato;
        console.log(`Corsa compatibile trovata:`);
        console.log(`  Corsa ID: ${corsa.id}`);
        console.log(`  Veicolo ID: ${slot.veicolo_id}`);
        console.log(`  Origine: ${corsa.origine_lat}, ${corsa.origine_lon}`);
        console.log(`  Destinazione: ${corsa.dest_lat}, ${corsa.dest_lon}`);
        console.log(`  Parametri per calcolo prezzo:`);
        console.log(`    km: ${kmPerPrezzo}`);
        console.log(`    tipo_corsa: ${corsa.tipo_corsa}`);
        console.log(`    posti prenotati: ${corsa.posti_prenotati}`);
        console.log(`    primo_posto: ${corsa.primo_posto}`);
        console.log(`    euro_km: ${corsa.euro_km ?? 1.0}`);
        console.log(`    posti richiesti: ${richiesta.posti_richiesti}`);
        console.log(`    stato: ${statoPrezzo}`);
        console.log(`  Prezzo calcolato: ${slot.prezzo.toFixed(2)} €`);
        console.log(`  Distanza corsa: ${corsa.distanza} km`);
      }
    });

    console.log('✅ Test completato: verifica calcolo prezzo senza km nella richiesta');
  } catch (err) {
    console.error('❌ Errore nel test corse compatibili:', err);
  } finally {
    await pool.end();
  }
}

testCorsaCompatibilePrezzoSenzaKm();
