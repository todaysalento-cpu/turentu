import { formatResults } from './services/search/formatter/search.formatter.js';

async function runTest() {
  console.log("🚀 Avvio Test di Integrazione: Formatter Ridesharing...");

  // 1. Mock dei dati (Simulazione Cache Veicoli)
  const mockVeicoliMap = new Map([
    [66, { id: 66, modello: 'Tesla Model 3', posti_totali: 4, tipo: 'berlina', servizi: '["wifi", "ac"]' }]
  ]);

  // 2. Simulazione richiesta utente
  const richiesta = { 
    posti_richiesti: 1, 
    coord: { lat: 45.46, lon: 9.19 }, 
    coordDest: { lat: 45.47, lon: 9.20 } 
  };
  
  // 3. Simulazione corsa esistente con occupazione dinamica (2 su 4 occupati)
  const corse = [{ 
    id: 1, 
    veicolo_id: 66, 
    picco_occupazione: 2, 
    stato: 'prenotabile', 
    origine_lat: 45.46, 
    origine_lon: 9.19,
    durata: '00:30:00',
    distanza: 10
  }];

  try {
    // Esecuzione del test iniettando il mock dei veicoli
    const risultati = await formatResults(richiesta, [], corse, mockVeicoliMap);
    
    const r = risultati[0];

    // Assertions di validazione
    console.log("--- Risultati Formatter ---");
    console.log(`Veicolo: ${r.modello}`);
    console.log(`Posti Totali: ${r.postiTotali} | Occupati: ${r.postiOccupati} | Disponibili: ${r.postiDisponibili}`);
    
    const testPassato = (r.postiDisponibili === 2 && r.postiOccupati === 2);
    
    if (testPassato) {
      console.log("✅ TEST PASSATO: Logica occupazione corretta.");
    } else {
      console.error("❌ TEST FALLITO: Il calcolo dei posti non coincide.");
    }

  } catch (err) {
    console.error("💥 Errore durante il test:", err);
  }
}

runTest();