// tests/test_pixel_territorial_discovery_v562.js
import { pool } from '../db/db.js';
import { comparePixelTerritorialDiscoveryV562, allocatePixelV562Quotas } from '../services/pixel/pixel-territorial-discovery-plan-v562.service.js';

let failures = 0;
try {
  // Test puramente logici, senza database.
  const qBari = allocatePixelV562Quotas(36,48);
  const qLecce = allocatePixelV562Quotas(71,48);
  if (qBari.geographicBudget < 36 || qLecce.geographicBudget !== 48) throw new Error('Quote adattive incoerenti');
  for (const [nome, codice] of [['BARI','072006'], ['LECCE','075035']]) {
    console.log(`\n========== ${nome} (${codice}) ==========`);
    const start = Date.now();
    const r = await comparePixelTerritorialDiscoveryV562(codice, { maxGoogleCalls:48, comparisonCenters:40 });
    const a = r.allocazione_adattiva;
    const p = r.piano_adattivo;
    const pairs = new Set(p.map(c => `${c.centro_id}:${c.categoria}`));
    const checks = {
      confronto_paritario: r.confronto_paritario.farthest_first.centri === r.confronto_paritario.marginal_gain.centri,
      budget_confronto: r.confronto_paritario.farthest_first.centri <= 40,
      limite_google: p.length <= 48,
      conteggio_chiamate: a.chiamate === p.length,
      sequenza: p.every((c,i) => c.numero === i+1),
      coppie_uniche: pairs.size === p.length,
      categorie_coerenti: Object.values(a.categorie).reduce((x,y)=>x+y,0) === p.length,
      quote_coerenti: Object.entries(a.quotas).every(([k,v]) => a.categorie[k] <= v),
      centri_coerenti: a.centri_esplorati <= r.centri_disponibili,
      confini_istat: r.diagnostica.centri_fuori_comune === 0,
      nessuna_google: r.diagnostica.nessuna_chiamata_google,
      nessuna_scrittura: r.diagnostica.nessuna_scrittura,
      copertura_valida: a.copertura_pct >= 0 && a.copertura_pct <= 100,
    };
    failures += Object.values(checks).filter(v => !v).length;
    console.log(JSON.stringify({
      comune:r.nome_comune, centri_disponibili:r.centri_disponibili,
      confronto_paritario:r.confronto_paritario,
      allocazione_adattiva:a,
      durata_ms:Date.now()-start,
      verifiche:Object.fromEntries(Object.entries(checks).map(([k,v])=>[k,v?'OK':'ERRORE'])),
    },null,2));
    console.log('Prime 10 interrogazioni del piano adattivo:');
    console.table(p.slice(0,10).map(c=>({numero:c.numero,centro:c.centro_id,categoria:c.categoria,guadagno_km2:c.guadagno_marginale_km2})));
  }
  console.log(`\nESITO: ${failures ? `VERIFICHE FALLITE: ${failures}` : 'VERIFICHE OK'}`);
  if (failures) process.exitCode=1;
} catch (e) { console.error('TEST FALLITO:',e); process.exitCode=1; }
finally { await pool.end(); }
