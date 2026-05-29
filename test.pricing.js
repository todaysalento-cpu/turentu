import { calcolaPrezzo } from './utils/pricing.util.js';
import * as db from './db/db.js'; // Assumendo che exporti 'pool'

// Mock del pool di database
db.pool.query = async (query, params) => {
  // Se è la query delle prenotazioni, fingiamo che ce ne sia già una con 2 passeggeri
  if (query.includes('FROM prenotazioni')) {
    return { rows: [{ num_prenotazioni: 1, tot_pass_precedenti: 2 }] };
  }
  // Se è la query delle tariffe, ritorniamo tariffe di test
  if (query.includes('FROM tariffe')) {
    return { rows: [{ euro_km: 0.5, prezzo_passeggero: 2.0 }] };
  }
  return { rows: [] };
};

async function runTest() {
  console.log("🚀 Avvio Test Pricing con Mock DB...");
  
  const corsaMock = { id: 999, veicolo_id: 66, distanza: 50 };

  try {
    // Ora calcolaPrezzo userà i nostri dati "finti" senza errori di constraint
    const prezzo = await calcolaPrezzo(corsaMock, 1, 'prenotabile', 50, 50);
    
    console.log(`Prezzo calcolato (con 2 pass. già presenti): €${prezzo}`);
    
    if (prezzo > 0) {
      console.log("✅ TEST PASSATO!");
    }
  } catch (err) {
    console.error("💥 Errore:", err);
  }
}

runTest();