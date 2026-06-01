import { fetchCorse } from './db/db.js';
import { filterDisponibilita } from './services/search/engine/availability.engine.js';

async function runDetailedTest() {
  // Struttura dati richiesta (Chiavi attese dal Motore: coord e coordDest)
  const richiesta = {
    coord: { lat: 41.8967, lon: 12.4822 },      // Origine (Roma)
    coordDest: { lat: 45.4642, lon: 9.1900 },   // Destinazione (Milano)
    posti_richiesti: 1
  };

  // Nomi leggibili per il log
  const nomi = {
    origine: "Roma",
    destinazione: "Milano"
  };

  console.log(`🔍 [TEST] Ricerca da ${nomi.origine} (${richiesta.coord.lat}, ${richiesta.coord.lon})`);
  console.log(`   Verso ${nomi.destinazione} (${richiesta.coordDest.lat}, ${richiesta.coordDest.lon})`);
  
  const corse = await fetchCorse();
  
  // Esecuzione del filtro
  const result = await filterDisponibilita(richiesta, corse, corse.map(() => []));

  console.log("\n--- RISULTATI CON DETTAGLIO RICHIESTA ---");
  
  if (result.corse && result.corse.length > 0) {
    console.table(result.corse.map(c => ({
      Corsa_ID: c.id,
      Tratta_DB: `${c.origine_address} -> ${c.destinazione_address}`,
      Prezzo: `€${c.prezzo_fisso}`,
      Posti_Disp: c.posti_disponibili,
      Origine_Richiesta: nomi.origine,
      Dest_Richiesta: nomi.destinazione
    })));
  } else {
    console.log("⚠️ Nessuna corsa trovata per questa tratta.");
  }

  console.log(`✅ Corse compatibili trovate: ${result.corse ? result.corse.length : 0}`);
}

runDetailedTest().catch(console.error);