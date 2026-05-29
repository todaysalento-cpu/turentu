import { filterDisponibilita } from './services/search/engine/availability.engine.js';

async function testPiccoOccupazione() {
  console.log("🔍 Avvio Test: Debug Capacità...");

  const validPolyline = "y}w_GkrupA_c|@cewpA"; 

  const testCases = [
    { desc: "Richiesta valida (1 posto)", picco: 0, richiesti: 1, atteso: true },
    { desc: "Richiesta al limite (4 posti occupati)", picco: 3, richiesti: 1, atteso: true },
    { desc: "Richiesta rifiutata (Saturazione)", picco: 3, richiesti: 2, atteso: false }
  ];

  for (const tc of testCases) {
    const corsa = { 
        id: 999, 
        posti_totali: 4, 
        picco_occupazione: tc.picco,
        path_geohashes: ["u0nd9"], 
        percorso_polyline: validPolyline,
        fermate_pianificate: [] 
    };

    const richiesta = { 
      posti_richiesti: tc.richiesti, 
      coord: { lat: 45.4642, lon: 9.1900 }, 
      coordDest: { lat: 45.4781, lon: 9.2270 },
      start_datetime: new Date().toISOString()
    };

    // Eseguiamo il motore con l'override per il test
    process.env.NODE_ENV = 'test';
    const risultati = filterDisponibilita(richiesta, [], [], [corsa]);
    const trovato = risultati.corse.length > 0;

    console.log(`Test: ${tc.desc} | Occupazione: ${tc.picco}/${corsa.posti_totali} + ${tc.richiesti} | Trovato: ${trovato}`);

    if (trovato === tc.atteso) {
      console.log(`✅ PASSED`);
    } else {
      console.error(`❌ FAILED (Atteso: ${tc.atteso})`);
    }
  }
}

testPiccoOccupazione().catch(console.error);