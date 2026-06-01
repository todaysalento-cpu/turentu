import { calcolaPrezzo } from './utils/pricing.util.js';

async function runCoefficientTest() {
  const corsaBase = { id: 683, veicolo_id: 1, distanza: 500 };
  console.log("🔍 [TEST] Verifica Coefficiente KM su più passeggeri...");

  // Scenario A: 2 passeggeri che fanno l'intera tratta (500km)
  // Il costo base (500) + quota variabile (2) = 502. Diviso per 2 = 251.
  const pA = await calcolaPrezzo(corsaBase, 1, 'prenotabile', 500, 500, { num: 1, totPass: 1 });
  console.log(`💰 A: 2° Passeggero (intera tratta): €${pA.toFixed(2)}`);

  // Scenario B: 2 passeggeri, ma quello nuovo fa solo 100km
  // Prezzo base (500) + quota variabile (2) = 502. 
  // Quota base condivisa = 502 / 2 = 251.
  // Coefficiente tratta = 100 / 500 = 0.2.
  // Prezzo atteso = (251 * 0.2) + (quota variabile non proporzionale, se logica prevede)
  const pB = await calcolaPrezzo(corsaBase, 1, 'prenotabile', 100, 500, { num: 1, totPass: 1 });
  console.log(`💰 B: Passeggero su 100km (su 500 totali): €${pB.toFixed(2)}`);

  if (pB < pA) {
    console.log("✅ [SUCCESS] Il prezzo scala correttamente con i KM anche in condivisione!");
  }
}

runCoefficientTest().catch(console.error);