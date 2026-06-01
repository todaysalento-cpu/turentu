import { calcolaPrezzo } from './utils/pricing.util.js';

async function runTest() {
  console.log("🚀 [TEST] Integrazione Pricing & Formattazione...");

  const mockCorsa = {
    id: 999,
    veicolo_id: 1,
    distanza: 500, // Corsa totale 500km
    stato: 'prenotabile'
  };

  // Definiamo la richiesta dell'utente
  const richiesta = { 
    posti_richiesti: 1,
    km_richiesti: 100 
  };

  console.log(`ℹ️ Richiesta: ${richiesta.posti_richiesti} posto/i per ${richiesta.km_richiesti}km`);

  // Test 1: Primo passeggero (Garante)
  const p1 = await calcolaPrezzo(
    mockCorsa, 
    richiesta.posti_richiesti, 
    'prenotabile', 
    richiesta.km_richiesti, 
    mockCorsa.distanza, 
    { num: 0, totPass: 0 }
  );
  console.log(`💰 1° Passeggero: €${p1.toFixed(2)}`);

  // Test 2: Secondo passeggero (Condivisione)
  const p2 = await calcolaPrezzo(
    mockCorsa, 
    richiesta.posti_richiesti, 
    'prenotabile', 
    richiesta.km_richiesti, 
    mockCorsa.distanza, 
    { num: 1, totPass: 1 } // Simuliamo che ci sia già 1 passeggero prima di lui
  );
  console.log(`💰 2° Passeggero: €${p2.toFixed(2)}`);

  console.log("\n--- Analisi Risultati ---");
  if (p2 < p1) {
    console.log("✅ [SUCCESS] Il prezzo diminuisce con la condivisione.");
  } else {
    console.log("⚠️ [CHECK] Il prezzo non è cambiato. Verifica la logica del coefficiente.");
  }
}

runTest().catch(console.error);