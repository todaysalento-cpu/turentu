import { cercaSlotUltra, loadCachesUltra } from '../services/search/searchUltra.service.js';
import { pool } from '../db/db.js';
import { haversineDistance } from '../utils/geo.util.js';

async function testPrezzoSlotECorse() {
  await loadCachesUltra();

  const richiesta = {
    coord: { lat: 41.8933203, lon: 12.4829321 },     // Origine
    coordDest: { lat: 45.4641943, lon: 9.1896346 },  // Destinazione
    posti_richiesti: 1,
    arrivo_datetime: '2026-01-30T12:00:00Z'
  };

  try {
    const risultati = await cercaSlotUltra(richiesta);

    console.log('Richiesta:', richiesta);

    risultati.forEach(slot => {
      if (slot.slot_libero) {
        const distanzaPrezzo = haversineDistance(
          richiesta.coord,
          richiesta.coordDest
        );

        console.log(`Slot libero: Veicolo ${slot.veicolo_id}`);
        console.log(`  Prezzo: ${slot.prezzo.toFixed(2)} €`);
        console.log(`  Euro/km: ${slot.euro_km?.toFixed(2) ?? 'N/D'}`);
        console.log(`  Distanza prezzo (origine → destinazione): ${distanzaPrezzo.toFixed(2)} km`);
        console.log(`  Distanza filtro slot (veicolo → origine): ${slot.distanzaKm.toFixed(2)} km`);
      } else {
        const corsa = slot.corseCompatibili[0];

        console.log(`Corsa compatibile trovata:`);
        console.log(`  Corsa ID: ${corsa.id}`);
        console.log(`  Veicolo ID: ${slot.veicolo_id}`);
        console.log(`  Origine: ${corsa.origine_lat}, ${corsa.origine_lon}`);
        console.log(`  Destinazione: ${corsa.dest_lat}, ${corsa.dest_lon}`);
        console.log(`  Parametri per calcolo prezzo:`);
        console.log(`    km (DB): ${Number(corsa.distanza).toFixed(2)}`);
        console.log(`    tipo_corsa: ${corsa.tipo_corsa}`);
        console.log(`    posti prenotati: ${corsa.posti_prenotati}`);
        console.log(`    primo_posto: ${corsa.primo_posto}`);
        console.log(`    euro_km: ${Number(corsa.euro_km).toFixed(2)}`);
        console.log(`    posti richiesti: ${richiesta.posti_richiesti}`);
        console.log(`    stato: ${corsa.stato === 'prenotabile' ? 'condiviso' : corsa.stato}`);
        console.log(`  Prezzo calcolato: ${slot.prezzo.toFixed(2)} €`);
        console.log(`  Distanza corsa (DB): ${Number(corsa.distanza).toFixed(2)} km`);
      }
    });

    console.log('✅ Test completato: distanze, euro/km e prezzi verificati');
  } catch (err) {
    console.error('❌ Errore nel test corse compatibili:', err);
  } finally {
    await pool.end();
  }
}

testPrezzoSlotECorse();
