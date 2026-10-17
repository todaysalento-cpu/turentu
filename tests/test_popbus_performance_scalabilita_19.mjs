// TURENTU POPBUS — TEST 19 / PERFORMANCE E SCALABILITA
// Salvare come tests/test_popbus_performance_scalabilita_19.mjs
// Eseguire: node tests/test_popbus_performance_scalabilita_19.mjs
// SOLO CPU/MEMORIA: nessun DB, Stripe, routing, socket o scrittura.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

console.log('=== TURENTU POPBUS / TEST 19 PERFORMANCE E SCALABILITA ===');
console.log('MODALITA: BENCHMARK OTTIMIZZATORE REALE + DATI SINTETICI / ZERO DB / ZERO STRIPE');
const file = resolve(process.cwd(), 'services/popbus/v2/fleet-optimizer.js');
if (!existsSync(file)) {
  console.error('FAIL File non trovato:', file);
  process.exitCode = 1;
} else {
  const { ottimizzaFlotta } = await import(pathToFileURL(file).href);
  let pass = 0, fail = 0, gap = 0;
  const ok = (label, fn) => {
    try { fn(); pass++; console.log('PASS', label); }
    catch (e) { fail++; console.log('FAIL', label, '—', e.message); }
  };
  const note = (label, detail) => { gap++; console.log('GAP ', label, '—', detail); };
  const rng = seed => () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  function buildScenario(requestCount, vehicleCount, seed) {
    const rand = rng(seed);
    const candidates = [];
    // Ogni candidata rappresenta un ciclo gia validato (1-3 missioni).
    // Le richieste sono riutilizzate tra candidate per simulare competizione.
    for (let i = 0; i < requestCount; i++) {
      const vehicle = 1 + Math.floor(rand() * vehicleCount);
      const startSlot = Math.floor(rand() * 48);
      const durationSlots = 1 + Math.floor(rand() * 4);
      const reqIds = [1 + Math.floor(rand() * requestCount)];
      if (rand() < 0.4) reqIds.push(1 + Math.floor(rand() * requestCount));
      if (rand() < 0.12) reqIds.push(1 + Math.floor(rand() * requestCount));
      const unique = [...new Set(reqIds)];
      const start = Date.UTC(2027, 3, 1, 6) + startSlot * 15 * 60_000;
      const end = start + durationSlots * 15 * 60_000;
      candidates.push({
        veicolo: vehicle, richieste: unique,
        partenza_base: new Date(start).toISOString(),
        ritorno_base: new Date(end).toISOString(),
        margine_ciclo_con_attesa_euro: Math.round((10 + rand() * 110) * 100) / 100,
        _testId: i
      });
    }
    return candidates;
  }
  function verifySelection(candidates, result) {
    assert.ok(Array.isArray(result.selezionati));
    const known = new Set(candidates);
    const seenRequests = new Set();
    const byVehicle = new Map();
    let sum = 0;
    for (const c of result.selezionati) {
      assert.ok(known.has(c), 'Selezionata candidata non presente in input');
      for (const id of c.richieste) {
        assert.ok(!seenRequests.has(id), `Richiesta ${id} assegnata due volte`);
        seenRequests.add(id);
      }
      const intervals = byVehicle.get(c.veicolo) ?? [];
      const start = Date.parse(c.partenza_base), end = Date.parse(c.ritorno_base);
      for (const [a, b] of intervals) assert.ok(start >= b || end <= a, `Conflitto veicolo ${c.veicolo}`);
      intervals.push([start, end]);
      byVehicle.set(c.veicolo, intervals);
      sum += Math.round(c.margine_ciclo_con_attesa_euro * 100);
    }
    assert.equal(result.cicliSelezionati, result.selezionati.length);
    assert.equal(result.richiesteCoperte, seenRequests.size);
    assert.equal(Math.round(result.margineTotaleEuro * 100), sum);
    assert.ok(result.nodiEsplorati >= 1);
    assert.equal(result.ottimoDimostrato, !result.limiteNodiRaggiunto && result.candidatiTagliati === 0);
  }
  const scenarios = [
    { name: 'PICCOLO', requests: 50, vehicles: 10, maxNodi: 40_000, maxCandidati: 5_000 },
    { name: 'MEDIO', requests: 250, vehicles: 50, maxNodi: 40_000, maxCandidati: 5_000 },
    { name: 'GRANDE', requests: 1000, vehicles: 100, maxNodi: 40_000, maxCandidati: 5_000 },
    { name: 'STRESS', requests: 5000, vehicles: 200, maxNodi: 40_000, maxCandidati: 5_000 }
  ];
  const results = [];
  ok('Ottimizzatore reale esporta funzione', () => assert.equal(typeof ottimizzaFlotta, 'function'));
  for (const [index, s] of scenarios.entries()) {
    console.log(`\n--- ${s.name}: ${s.requests} RICHIESTE / ${s.vehicles} VEICOLI ---`);
    const beforeGenerate = performance.now();
    const candidates = buildScenario(s.requests, s.vehicles, 1900 + index);
    const generatedMs = performance.now() - beforeGenerate;
    const heapBefore = process.memoryUsage().heapUsed;
    let output, elapsed;
    try {
      const start = performance.now();
      output = ottimizzaFlotta(candidates, { maxNodi: s.maxNodi, maxCandidati: s.maxCandidati });
      elapsed = performance.now() - start;
      ok(`${s.name}: soluzione senza richieste duplicate/conflitti`, () => verifySelection(candidates, output));
      ok(`${s.name}: nessuna candidata aggiunta o alterata`, () => {
        assert.equal(candidates.length, s.requests);
        assert.ok(output.selezionati.every(x => candidates.includes(x)));
      });
      ok(`${s.name}: limiti di ricerca rispettati`, () => {
        assert.ok(output.nodiEsplorati <= s.maxNodi);
        assert.ok(output.candidatiValutati <= s.maxCandidati);
        assert.equal(output.candidatiTagliati, Math.max(0, output.candidatiAmmissibili - s.maxCandidati));
      });
      if (output.limiteNodiRaggiunto || output.candidatiTagliati) {
        note(`${s.name}: soluzione non certificata ottima`, `nodi=${output.nodiEsplorati}; troncate=${output.candidatiTagliati}`);
      }
      const memoryMB = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
      const row = {
        scenario: s.name, richieste: s.requests, veicoli: s.vehicles,
        candidate: candidates.length, generazione_ms: +generatedMs.toFixed(2),
        ottimizzazione_ms: +elapsed.toFixed(2), delta_heap_MB: +memoryMB.toFixed(2),
        nodi: output.nodiEsplorati, cicli_scelti: output.cicliSelezionati,
        richieste_coperte: output.richiesteCoperte, margine_euro: output.margineTotaleEuro,
        troncate: output.candidatiTagliati, limite_nodi: output.limiteNodiRaggiunto,
        ottimo_dimostrato: output.ottimoDimostrato
      };
      results.push(row);
      console.log('METRICHE', JSON.stringify(row));
    } catch (err) {
      fail++;
      console.log('FAIL', `${s.name}: esecuzione reale ottimizzatore`, '—', err.stack || err.message);
    }
  }
  // Un caso costruito per forzare il limite nodi, senza imporre una specifica durata.
  const forced = buildScenario(100, 10, 19099);
  ok('Limite nodi forzato non dichiarato ottimo', () => {
    const out = ottimizzaFlotta(forced, { maxNodi: 1, maxCandidati: 100 });
    assert.equal(out.limiteNodiRaggiunto, true);
    assert.equal(out.ottimoDimostrato, false);
    verifySelection(forced, out);
  });
  ok('Taglio candidate non dichiarato ottimo', () => {
    const out = ottimizzaFlotta(forced, { maxNodi: 40_000, maxCandidati: 5 });
    assert.ok(out.candidatiTagliati > 0);
    assert.equal(out.ottimoDimostrato, false);
    verifySelection(forced, out);
  });
  note('Generazione candidati / PIXEL / worker non misurati', 'Si misura il vero fleet-optimizer.js, ma le candidate sono sintetiche e gia validate.');
  note('PostgreSQL, Google routing e rete non misurati', 'Nessuna query, richiesta esterna o concorrenza di processi.');
  note('Prestazioni produzione non certificate', 'Tempi dipendono da CPU, carico, runtime; ripetere su macchina e dati rappresentativi.');
  console.log('\nTABELLA PERFORMANCE');
  console.table(results);
  console.log('RIEPILOGO', JSON.stringify({ pass, fail, gap, scenari: results.length, mode: 'OTTIMIZZATORE REALE / INPUT SINTETICI / ZERO SCRITTURE' }, null, 2));
  console.log(`ESITO: ${pass} PASS, ${fail} FAIL, ${gap} GAP. Nessuna scrittura.`);
  if (fail) process.exitCode = 1;
}
