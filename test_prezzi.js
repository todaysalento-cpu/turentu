import { calcolaPrezzo } from './utils/pricing.util.js';

async function runPricingTest() {
  const corsaBase = { id: 683, veicolo_id: 1, distanza: 500 };

  console.log("🔍 [TEST] Analisi Pricing Dinamico (Ride-Sharing)...");

  // Scenario 1: Nessuno a bordo
  const p1 = await calcolaPrezzo(corsaBase, 1, 'prenotabile', 500, 500, { num: 0, totPass: 0 });
  console.log(`💰 1° Passeggero (tratta intera): €${p1.toFixed(2)}`);

  // Scenario 2: 1 persona a bordo (condivisione)
  const p2 = await calcolaPrezzo(corsaBase, 1, 'prenotabile', 500, 500, { num: 1, totPass: 1 });
  console.log(`💰 2° Passeggero (condivisa con 1): €${p2.toFixed(2)}`);

  // Scenario 3: Tratta parziale
  const p3 = await calcolaPrezzo(corsaBase, 1, 'prenotabile', 250, 500, { num: 1, totPass: 1 });
  console.log(`💰 1 Passeggero (mezza tratta, condivisa): €${p3.toFixed(2)}`);

  if (p2 < p1 && p3 < p2) {
    console.log("✅ [SUCCESS] Pricing dinamico verificato.");
  } else {
    console.log("❌ [FALLITO] Il prezzo non diminuisce con la condivisione.");
  }
}

runPricingTest().catch(console.error);