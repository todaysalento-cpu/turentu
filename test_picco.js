import { fetchCorse } from './db/db.js';
import { filterDisponibilita } from './services/search/engine/availability.engine.js';

async function runPiccoTest() {
  const corse = await fetchCorse();
  const testCorsa = corse.find(c => c.id === 683);
  if (!testCorsa) return console.log("Corsa 683 non trovata.");

  // Forziamo il totale a 2 posti per rendere il test più sensibile al picco
  testCorsa.posti_totali = 2; 
  testCorsa.posti_prenotati = 0; // Azzeriamo il DB per controllare solo la nostra simulazione

  // Scenario: 2 prenotazioni da 1 posto l'una che si sovrappongono nel tratto 40-50
  const prenotazioniSimulate = [
    [
      { posti_richiesti: 1, start_index_polyline: 0, end_index_polyline: 50 },
      { posti_richiesti: 1, start_index_polyline: 40, end_index_polyline: 100 }
    ]
  ];

  // Richiesta: Utente vuole 1 posto da indice 20 a 70
  // Il segmento 40-50 è già occupato da 2 persone (1+1). 
  // Con soli 2 posti totali, la corsa deve sparire!
  const richiesta = {
    coord: { lat: 41.8967, lon: 12.4822 }, 
    coordDest: { lat: 45.4642, lon: 9.1900 },
    posti_richiesti: 1
  };

  console.log(`🔍 [TEST] Analisi Picco Occupazione su Corsa ${testCorsa.id}`);
  console.log(`   Configurazione: Totali=2, Prenotate(DB)=0, Simulate=2`);
  
  const result = await filterDisponibilita(richiesta, [testCorsa], prenotazioniSimulate);

  if (result.corse.length === 0) {
    console.log("✅ [SUCCESS] Corsa scartata: il picco di occupazione (2/2) satura la capacità.");
  } else {
    console.log(`❌ [FALLITO] Corsa trovata con ${result.corse[0].postiDisponibili} posti liberi.`);
  }
}

runPiccoTest().catch(console.error);