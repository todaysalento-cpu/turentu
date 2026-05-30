import { filterDisponibilita } from './services/search/engine/availability.engine.js'; // Sostituisci con il tuo path

// 1. Mock Dati
const mockRichiesta = {
  id: "req_1",
  coord: { lat: 45.4642, lon: 9.1900 }, // Milano
  coordDest: { lat: 45.0703, lon: 7.6869 }, // Torino
  posti_richiesti: 1
};

const mockCorse = [
  {
    id: "corsa_corretta",
    decodedCoords: [
      [45.4642, 9.1900], // Partenza Milano
      [45.0703, 7.6869]  // Arrivo Torino
    ],
    posti_totali: 4,
    picco_occupazione: 0
  },
  {
    id: "corsa_inversa",
    decodedCoords: [
      [45.0703, 7.6869], // Torino (Direzione opposta!)
      [45.4642, 9.1900]  // Milano
    ],
    posti_totali: 4,
    picco_occupazione: 0
  }
];

// 2. Esecuzione Test
function runTest() {
  console.log("--- Avvio Test Filtraggio ---");
  
  const result = filterDisponibilita(
    mockRichiesta, 
    [], // veicoliCache vuota (non serve per il test corse)
    [], // disponibilitaCache vuota
    mockCorse, 
    []  // puntiRaccolta vuoti
  );

  const foundIds = result.corse.map(c => c.id);
  
  console.log("Corse trovate:", foundIds);
  
  if (foundIds.includes("corsa_corretta") && !foundIds.includes("corsa_inversa")) {
    console.log("✅ TEST SUPERATO: La logica di direzione funziona.");
  } else {
    console.error("❌ TEST FALLITO: Il filtro non ha isolato correttamente le corse.");
  }
}

runTest();