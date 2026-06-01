import { filterDisponibilita } from './services/search/engine/availability.engine.js'; // Il tuo file del Motore 1

async function testSistemaCompleto() {
  console.log("🚀 AVVIO TEST DI INTEGRAZIONE: Richiesta Intermedia");

  // 1. Dati Simulati (basati sulla tua struttura DB)
  const richiesta = {
    coord: { lat: 44.0565, lon: 12.5713 }, // Rimini
    coordDest: { lat: 44.4948, lon: 11.3426 }, // Bologna
    posti_richiesti: 1
  };

  // Corsa reale presa dal tuo DB (Corsa 753)
  const corseCandidate = [{
    id: 753,
    veicolo_id: 223,
    posti_totali: 4,
    prezzo_fisso: 15.00,
    start_datetime: '2026-06-01T10:00:00Z',
    decodedCoords: [
        [11.34, 44.49], [12.57, 44.05] // Semplificata per il test
    ]
  }];

  // Prenotazioni esistenti per la corsa 753
  const prenotazioniData = [[
    { posti_richiesti: 1 } // Simuliamo che ci sia già 1 posto occupato
  ]];

  // 2. Esecuzione del Filtro
  const result = await filterDisponibilita(richiesta, corseCandidate, prenotazioniData);

  // 3. Verifica Risultati
  console.log("--- RISULTATO TEST ---");
  if (result.corse.length > 0) {
    const corsa = result.corse[0];
    console.log(`✅ Corsa ${corsa.id} trovata.`);
    console.log(`📊 Posti disponibili calcolati: ${corsa.postiDisponibili} (Attesi: 3)`);
    
    if (corsa.postiDisponibili === 3) {
      console.log("🎉 TEST SUPERATO: Logica occupazione corretta.");
    } else {
      console.log("⚠️ TEST PARZIALE: Corsa trovata ma calcolo posti errato.");
    }
  } else {
    console.log("❌ TEST FALLITO: Nessuna corsa trovata.");
  }
}

testSistemaCompleto();