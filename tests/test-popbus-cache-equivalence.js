// TURENTU POPBUS V2 - confronto cache ON/OFF sullo stesso snapshot logico.
// SOLO test SHADOW read-only. Non importare da worker/route.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pool } from '../db/db.js';
import { processaPixelFirstMultimissione } from '../services/popbus/v2/pixel-first-multimission-service.js';
import { bridgeFermateDiagnostiche } from '../services/popbus/v2/popbus-shadow-diagnostic-stops.service.js';

if (process.env.POPBUS_SHADOW_DIAGNOSTIC_STOPS !== '1' ||
    process.env.POPBUS_SHADOW_EXCLUDE_TEST_VEHICLES !== '1' ||
    !process.env.POPBUS_PHYSICAL_DIAGNOSTIC_LIMIT) {
  throw new Error('Richiesti POPBUS_SHADOW_DIAGNOSTIC_STOPS=1, POPBUS_SHADOW_EXCLUDE_TEST_VEHICLES=1 e limite diagnostico');
}

const original = process.env.POPBUS_SHADOW_DISABLE_PHYSICAL_CACHE;
const now = Date.now(); // stessa finestra temporale per entrambe le esecuzioni
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize(value[k])]));
  return value;
};
function signature(c) {
  // Tutti i campi del candidato, inclusi fermate, richieste, orari,
  // distanze, validazione e assegnazione veicolo.
  return JSON.stringify(normalize(c));
}
async function run(disableCache) {
  process.env.POPBUS_SHADOW_DISABLE_PHYSICAL_CACHE = disableCache ? '1' : '0';
  const started = performance.now();
  const result = await processaPixelFirstMultimissione({
    pool, now, mode:'ROLLBACK_ONLY', physicalShadow:true,
    physicalShadowBridge:bridgeFermateDiagnostiche
  });
  assert.equal(result.attivabile, false);
  assert.equal(result.dbWrites, 0);
  assert.ok(Array.isArray(result.candidati));
  return {
    result,
    ms:Math.round(performance.now()-started),
    signatures:result.candidati.map(signature).sort()
  };
}
try {
  const noCache = await run(true);
  const cached = await run(false);
  const a=noCache.result.diagnostica, b=cached.result.diagnostica;
  const same=JSON.stringify(noCache.signatures)===JSON.stringify(cached.signatures);
  console.log('CONFRONTO_CACHE_SHADOW',JSON.stringify({
    identici:same,
    senzaCache:{tentativi:a.tentativi,calcoliFisici:a.calcoliFisici,cacheHits:a.cacheHits,
      alternative:noCache.result.candidati.length,tempoTotaleMs:noCache.ms,
      tempoCalcoliFisiciMs:a.tempoCalcoliFisiciMs},
    conCache:{tentativi:b.tentativi,calcoliFisici:b.calcoliFisici,cacheHits:b.cacheHits,
      alternative:cached.result.candidati.length,tempoTotaleMs:cached.ms,
      tempoCalcoliFisiciMs:b.tempoCalcoliFisiciMs},
    parziali:!!(noCache.result.diagnostica.interrottoPerBudget || cached.result.diagnostica.interrottoPerBudget),
    dbWrites:0,attivabile:false
  },null,2));
  assert.equal(a.tentativi,b.tentativi,'Campioni diversi');
  assert.equal(a.calcoliFisici,a.tentativi,'Cache OFF ha riutilizzato calcoli');
  assert.equal(b.calcoliFisici+b.cacheHits,b.tentativi,'Contatori cache incoerenti');
  assert.equal(same,true,'I candidati differiscono con cache ON/OFF');
  console.log('ESITO_CONFRONTO_CACHE OK');
} catch(e) {
  console.error('ERRORE_CONFRONTO_CACHE',e.stack||e);
  process.exitCode=1;
} finally {
  if (original===undefined) delete process.env.POPBUS_SHADOW_DISABLE_PHYSICAL_CACHE;
  else process.env.POPBUS_SHADOW_DISABLE_PHYSICAL_CACHE=original;
  await pool.end();
}
