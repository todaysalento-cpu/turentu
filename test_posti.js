import { fetchCorse } from './db/db.js';
import { filterDisponibilita } from './services/search/engine/availability.engine.js';

async function runPostiTest() {
  const corse = await fetchCorse();
  if (corse.length === 0) return;

  // Scegliamo la prima corsa disponibile per il test
  const testCorsa = corse[0];
  console.log(`🔍 [TEST] Test calcolo posti per Corsa ID: ${testCorsa.id}`);
  console.log(`   Totali: ${testCorsa.posti_totali}, Già prenotati (DB): ${testCorsa.posti_prenotati}`);

  // Simuliamo una prenotazione in corso (es. un altro utente ha già chiesto 1 posto)
  const prenotazioniSimulate = [
    [{ posti_richiesti: 1 }] // Questo slot occupa 1 posto
  ];

  const richiesta = {
    coord: { lat: 41.8967, lon: 12.4822 },
    coordDest: { lat: 45.4642, lon: 9.1900 },
    posti_richiesti: 1 // L'utente attuale vuole 1 posto
  };

  const result = await filterDisponibilita(richiesta, [testCorsa], prenotazioniSimulate);

  if (result.corse.length > 0) {
    const calcolato = result.corse[0].postiDisponibili;
    console.log(`✅ Risultato: Posti liberi calcolati = ${calcolato}`);
    
    // Verifica logica
    const atteso = Number(testCorsa.posti_totali) - Number(testCorsa.posti_prenotati) - 1;
    if (calcolato === atteso) {
      console.log("🚀 [OK] Il calcolo dei posti è CORRETTO.");
    } else {
      console.log(`❌ [ERRORE] Atteso ${atteso}, ma trovato ${calcolato}.`);
    }
  } else {
    console.log("⚠️ Corsa non trovata (potrebbe essere piena).");
  }
}

runPostiTest().catch(console.error);