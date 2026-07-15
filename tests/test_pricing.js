import { calcolaPrezzo, getTariffe } from '../utils/pricing.util.js';
import { pool } from '../db/db.js';

let testPassati = 0;
let testTotali = 0;

function assert(condizione, messaggio) {
  testTotali++;
  if (condizione) {
    testPassati++;
    console.log(`  ✅ [PASS] ${messaggio}`);
  } else {
    console.error(`  ❌ [FAIL] ${messaggio}`);
  }
}

async function eseguiTestPricingConDettagli() {
  console.log('🧪 [TEST] Avvio suite con stampa dettagliata di euro_km, km e formule...\n');
  const originalQuery = pool.query;

  // ==========================================
  // TEST 1: Corsa Standard e Privata
  // ==========================================
  console.log('--- TEST 1: Corsa Standard e Privata ---');
  
  // 1A. Standard con tariffa default
  pool.query = async () => ({ rows: [] });
  const kmU1 = 10;
  const euroKmDef = 0.50;
  console.log(`  ℹ️ [INFO 1A] Parametri: euro_km=${euroKmDef} (default), kmUtente=${kmU1}, classe=STANDARD (mult: 1.0)`);
  console.log(`  ℹ️ [FORMULA 1A] Prezzo = (${euroKmDef} * ${kmU1}) * 1.0 = ${euroKmDef * kmU1} €`);
  
  const resStd = await calcolaPrezzo({ veicolo_id: null }, 1, 'standard', kmU1, kmU1, 0, 'STANDARD');
  console.log(`  📥 [RISULTATO 1A] Prezzo calcolato: ${resStd.prezzo} € (Target passeggeri: ${resStd.targetPasseggeri})`);
  assert(resStd.prezzo === 5.00, `Prezzo standard default corretto (${resStd.prezzo} €)`);

  // 1B. Privata con tariffa custom e Express
  pool.query = async (sql) => {
    if (sql.includes('tariffe')) return { rows: [{ euro_km: 0.75, prezzo_passeggero: 1.50 }] };
    return { rows: [] };
  };
  const euroKmCustom = 0.75;
  const kmU1B = 12.3;
  const multExpr = 1.4;
  console.log(`  ℹ️ [INFO 1B] Parametri: euro_km=${euroKmCustom} (custom), kmUtente=${kmU1B}, classe=EXPRESS (mult: ${multExpr})`);
  console.log(`  ℹ️ [FORMULA 1B] Prezzo = (${euroKmCustom} * ${kmU1B}) * ${multExpr} = ${(euroKmCustom * kmU1B) * multExpr} €`);

  const resExpr = await calcolaPrezzo({ veicolo_id: 5 }, 1, 'privata', kmU1B, kmU1B, 0, 'EXPRESS');
  console.log(`  📥 [RISULTATO 1B] Prezzo calcolato: ${resExpr.prezzo} €`);
  assert(resExpr.prezzo === 12.92, `Prezzo espresso custom arrotondato (${resExpr.prezzo} €)`);

  // ==========================================
  // TEST 2: Corsa Condivisa
  // ==========================================
  console.log('\n--- TEST 2: Corsa Condivisa ---');
  pool.query = async (sql) => {
    if (sql.includes('tariffe')) return { rows: [{ euro_km: 1.00, prezzo_passeggero: 2.00 }] };
    return { rows: [] };
  };

  const euroKmCond = 1.00;
  const prezPass = 2.00;
  const kmTot = 20;
  const kmU2 = 10;
  const passCurr = 1;
  const passRichiesti = 1;
  const passTotFin = passCurr + passRichiesti; // 2
  const costoBase = (euroKmCond * kmTot) + ((passTotFin - 1) * prezPass); // (1.00 * 20) + (1 * 2.00) = 22
  const prezzoTeorico = ((costoBase / passTotFin) * (kmU2 / kmTot)); // (22 / 2) * (10 / 20) = 11 * 0.5 = 5.50

  console.log(`  ℹ️ [INFO 2] Parametri: euro_km=${euroKmCond}, prezzo_passeggero=${prezPass}`);
  console.log(`  ℹ️ [INFO 2] Distanze: kmTotali=${kmTot}, kmUtente=${kmU2} (Rapporto km: ${kmU2/kmTot})`);
  console.log(`  ℹ️ [INFO 2] Passeggeri: correnti=${passCurr}, richiesti=${passRichiesti}, totali_finale=${passTotFin}`);
  console.log(`  ℹ️ [FORMULA 2] CostoBase = (${euroKmCond} * ${kmTot}) + ((${passTotFin}-1) * ${prezPass}) = ${costoBase} €`);
  console.log(`  ℹ️ [FORMULA 2] Prezzo = (${costoBase} / ${passTotFin}) * (${kmU2} / ${kmTot}) = ${prezzoTeorico} €`);

  const resCond = await calcolaPrezzo({ veicolo_id: 10 }, passRichiesti, 'condivisa', kmU2, kmTot, passCurr, 'STANDARD');
  console.log(`  📥 [RISULTATO 2] Prezzo calcolato: ${resCond.prezzo} €`);
  assert(resCond.prezzo === 5.50, `Prezzo condiviso corretto (${resCond.prezzo} €)`);

  // ==========================================
  // TEST 3: Corsa Pop-Bus
  // ==========================================
  console.log('\n--- TEST 3: Corsa Pop-Bus (Pool di veicoli e indici) ---');
  pool.query = async (sql) => {
    if (sql.includes('FROM tariffe t JOIN veicolo v')) {
      return {
        rows: [
          { veicolo_id: 1, euro_km: 0.40, posti_totali: 30 },
          { veicolo_id: 2, euro_km: 1.20, posti_totali: 8 }
        ]
      };
    }
    if (sql.includes('SELECT veicolo_id FROM direttrici_virtuali')) {
      return { rows: [{ veicolo_id: 2 }] };
    }
    return { rows: [] };
  };

  console.log(`  ℹ️ [INFO 3] Pool veicoli disponibili: [ID 1: euro_km=0.40, posti=30], [ID 2: euro_km=1.20, posti=8]`);
  console.log(`  ℹ️ [INFO 3] Classe richiesta: SAVER (soglia break-even: 0.9, range indice: 0.0 - 0.3)`);
  
  const corsaMock = { veicoli_pool_ids: [1, 2] };
  const resSaver = await calcolaPrezzo(corsaMock, 2, 'popbus', 5, 10, 0, 'SAVER');
  console.log(`  📥 [RISULTATO 3] Prezzo Pop-Bus calcolato: ${resSaver.prezzo} € | Target Passeggeri: ${resSaver.targetPasseggeri}`);
  assert(typeof resSaver.prezzo === 'number' && resSaver.prezzo >= 0.50, `Prezzo Pop-Bus SAVER calcolato (${resSaver.prezzo} €)`);

  // ==========================================
  // TEST 4: Controllo Prezzo Minimo (Floor)
  // ==========================================
  console.log('\n--- TEST 4: Applicazione Prezzo Minimo (PREZZO_MINIMO = 0.50) ---');
  pool.query = async () => ({ rows: [] });
  
  const kmCorto = 0.1;
  console.log(`  ℹ️ [INFO 4] Tratta cortissima: kmUtente=${kmCorto}, euro_km=0.50 -> Teoria: ${0.50 * kmCorto} €`);
  console.log(`  ℹ️ [INFO 4] Intervento regola PREZZO_MINIMO (0.50 €)`);

  const resMin = await calcolaPrezzo({ veicolo_id: null }, 1, 'standard', kmCorto, kmCorto, 0, 'SAVER');
  console.log(`  📥 [RISULTATO 4] Prezzo forzato al minimo: ${resMin.prezzo} €`);
  assert(resMin.prezzo === 0.50, `Prezzo minimo applicato correttamente (${resMin.prezzo} €)`);

  // ==========================================
  // TEST 5: Gestione resiliente errori DB
  // ==========================================
  console.log('\n--- TEST 5: Gestione resiliente errori DB ---');
  pool.query = async () => {
    throw new Error('Errore di connessione al database simulato');
  };
  console.log(`  ℹ️ [INFO 5] Simulazione crash/timeout DB durante la richiesta tariffe...`);

  const resDbErr = await calcolaPrezzo({ veicolo_id: 1 }, 1, 'standard', 10, 10, 0, 'STANDARD');
  console.log(`  📥 [RISULTATO 5] Fallback attivato con successo. Prezzo di sicurezza: ${resDbErr.prezzo} €`);
  assert(resDbErr.prezzo === 5.00, `Fallback sicuro attivo in caso di errore DB (${resDbErr.prezzo} €)`);

  pool.query = originalQuery; // Ripristina pool

  console.log(`\n📊 Risultati Finali Test Pricing: ${testPassati}/${testTotali} superati.`);
}

eseguiTestPricingConDettagli();