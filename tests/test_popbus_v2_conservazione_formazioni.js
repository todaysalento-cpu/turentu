// POPBUS V2 — TEST CONSERVAZIONE FORMAZIONI, SOLO CPU / ZERO DB
// Salva come tests/test_popbus_v2_conservazione_formazioni.js
// Esegui: node tests\test_popbus_v2_conservazione_formazioni.js
// Non importa worker.js o planner.js; non modifica produzione.
import assert from 'node:assert/strict';
import { generaCandidate, generaFormazioniAlternative } from '../services/popbus/v2/model.js';
import { diagnosticaCandidateTemporali } from '../services/popbus/v2/temporal-experiment.js';

const BASE = Date.parse('2027-04-01T10:00:00Z');
const MIN = 60000;
const secs = 600;
const make = (n, shift, extras = []) => [
  ...Array.from({ length: n }, (_, i) => ({
    id: i + 1, start_node_id: i + 1, end_node_id: i + 2,
    start_datetime: new Date(BASE + i * 10 * MIN + shift(i) * MIN).toISOString(),
    posti_richiesti: 1, prezzo: 30, classe: 'STANDARD', classe_percorrenza: 'BASSA'
  })), ...extras
];
const roadSeconds = async () => secs;
const planFor = c => ({
  nodes: c.nodes,
  legs: Array.from({ length: c.nodes.length - 1 }, () => ({
    seconds: secs, metres: 10000, roadCoincident: false
  }))
});
const sig = a => a.requests.map(r => Number(r.id)).sort((x, y) => x - y).join(',');
const candidateKey = c => `${c.classe}|${c.nodes.join('>')}|${c.seeds.join(',')}`;

async function compare(name, requests, routing = roadSeconds, opts = {}) {
  const candidates = generaCandidate(requests);
  const diagnosis = await diagnosticaCandidateTemporali(requests, { roadSeconds: routing });
  assert.equal(diagnosis.details.length, candidates.length);
  const baseline = new Set(), filtered = new Set();
  let skippedPlans = 0, removedValid = 0, baselineFormations = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i], d = diagnosis.details[i];
    assert.deepEqual(d.nodes, c.nodes);
    assert.deepEqual(d.seeds, c.seeds);
    const plan = planFor(c);
    const alternatives = generaFormazioniAlternative(plan, requests, c.seeds, {
      maxFormazioni: 80, ...opts
    });
    for (const a of alternatives) {
      baseline.add(`${candidateKey(c)}|${sig(a)}`);
      baselineFormations++;
    }
    // Scarto SIMULATO: il modulo sperimentale non scarta in produzione.
    if (d.seedTemporallyCompatible === false) {
      skippedPlans++;
      removedValid += alternatives.length;
      continue;
    }
    for (const a of alternatives) filtered.add(`${candidateKey(c)}|${sig(a)}`);
  }
  const lost = [...baseline].filter(x => !filtered.has(x));
  console.log(name, {
    candidate: candidates.length, pianiScartabili: skippedPlans,
    formazioniBaseline: baselineFormations,
    formazioniUnicheBaseline: baseline.size,
    formazioniUnicheConFiltro: filtered.size,
    formazioniPerse: lost.length, scartiConFormazioni: removedValid,
    routingCalls: diagnosis.stats.routingCalls,
    routingIndeterminato: diagnosis.stats.indeterminate
  });
  assert.equal(removedValid, 0, 'Scartata una candidata con alternative valide');
  assert.deepEqual([...filtered].sort(), [...baseline].sort(), 'Formazioni perse');
  return { skippedPlans, candidate: candidates.length };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS', name, '\n'); }
  catch (e) { console.error('FAIL', name, e.stack || e.message); process.exitCode = 1; }
}

await test('01 - 10 richieste allineate', async () => {
  const x = await compare('allineate', make(10, () => 0));
  assert.equal(x.skippedPlans, 0);
});
await test('02 - 20 richieste alternate di 2h', async () => {
  const x = await compare('alternate_2h', make(20, i => i % 2 ? 120 : 0));
  assert.ok(x.skippedPlans > 0);
});
await test('03 - 20 richieste progressive di 2h', async () => {
  const x = await compare('progressive_2h', make(20, i => i * 120));
  assert.ok(x.skippedPlans > 0);
});
await test('04 - richiesta aggiuntiva sulla stessa tratta', async () => {
  const extra = {
    id: 100, start_node_id: 1, end_node_id: 3,
    start_datetime: new Date(BASE).toISOString(),
    posti_richiesti: 1, prezzo: 50, classe: 'STANDARD', classe_percorrenza: 'BASSA'
  };
  await compare('richiesta extra', make(8, i => i % 2 ? 120 : 0, [extra]));
});
await test('05 - routing indisponibile: nessuno scarto', async () => {
  const x = await compare('routing fallito', make(8, i => i * 120),
    async () => { throw new Error('offline'); });
  assert.equal(x.skippedPlans, 0);
});
await test('06 - routing diverso dal piano: rilevazione del rischio', async () => {
  // Prefiltro: 10 minuti tra nodo 1 e nodo 2.
  // Planner definitivo: 100 minuti tra nodo 1 e nodo 2.
  // Le partenze sono a 100 minuti di distanza. Con tolleranza ±30 minuti,
  // la differenza vista dal prefiltro (90 minuti) supera i 60 minuti
  // di sovrapposizione complessiva delle finestre e deve risultare incompatibile.
  const requests = make(2, () => 0);
  requests[1].start_datetime = new Date(BASE + 100 * MIN).toISOString();
  const diagnosis = await diagnosticaCandidateTemporali(requests, { roadSeconds });
  const candidate = generaCandidate(requests).find(c => c.seeds.length === 2);
  const detail = diagnosis.details.find(d => d.seeds.length === 2);
  assert.ok(candidate, 'Candidata con due seed non generata');
  assert.ok(detail, 'Diagnosi candidata con due seed assente');
  const offsetMin = (Date.parse(requests[1].start_datetime) - Date.parse(requests[0].start_datetime)) / MIN;
  console.log('SCENARIO 06', {
    differenzaPartenzeMin: offsetMin,
    tempoPrefiltroPrimaTrattaMin: secs / 60,
    tempoPlannerPrimaTrattaMin: 100,
    compatibilePrefiltro: detail.seedTemporallyCompatible,
    nodes: candidate.nodes, seeds: candidate.seeds
  });
  assert.equal(offsetMin, 100);
  assert.equal(detail.seedTemporallyCompatible, false,
    'Il prefiltro avrebbe dovuto giudicare incompatibili i due seed');
  const actualPlan = { nodes: candidate.nodes, legs: [
    { seconds: 6000, metres: 10000, roadCoincident: false },
    { seconds: 600, metres: 10000, roadCoincident: false }
  ] };
  const actual = generaFormazioniAlternative(actualPlan, requests, candidate.seeds, {
    maxFormazioni: 80, qualityEnabled: false
  });
  const bothSeeds = actual.filter(a => {
    const ids = new Set(a.requests.map(r => Number(r.id)));
    return candidate.seeds.every(id => ids.has(Number(id)));
  });
  console.log('SCENARIO 06 FORMAZIONI', {
    alternativeTotali: actual.length,
    alternativeConEntrambiISeed: bothSeeds.length
  });
  assert.ok(bothSeeds.length > 0,
    'Il piano definitivo non ha prodotto una formazione con entrambi i seed: verificare la logica di valutazione');
  console.log('RISCHIO CONFERMATO: lo scarto preliminare avrebbe perso una formazione valida');
});

console.log(`ESITO: ${passed}/6 test PASS`);
if (passed !== 6) process.exitCode = 1;
