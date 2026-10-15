// TURENTU POPBUS V2 - REGRESSIONE MODEL (sola CPU, zero DB)
// Percorso: tests/test_popbus_v2_regressione_model.js
// Esecuzione: node tests\test_popbus_v2_regressione_model.js
import assert from 'node:assert/strict';
import {
  generaCandidate,
  valutaRichieste,
  generaFormazioniAlternative,
  verificaQualitaRichieste,
  TOLLERANZA_MS
} from '../services/popbus/v2/model.js';

const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const min = n => n * 60_000;
const req = (id, a, b, offsetMin = 0, posti = 1, prezzo = 30, classe = 'STANDARD') => ({
  id, start_node_id: a, end_node_id: b,
  start_datetime: new Date(T0 + min(offsetMin)).toISOString(),
  posti_richiesti: posti, prezzo, classe,
  classe_percorrenza: 'BASSA'
});
const plan = {
  nodes: [1, 2, 3],
  legs: [
    { metres: 10000, seconds: 600, roadCoincident: false },
    { metres: 10000, seconds: 600, roadCoincident: false }
  ]
};
const options = { qualityEnabled: false };
const signature = cs => cs.map(c => `${c.classe}|${c.nodes.join('-')}|${c.seeds.join(',')}`).sort();

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('01 - tre richieste in catena generano 6 candidate', () => {
  const rs = [req(1,1,2), req(2,2,3), req(3,3,4)];
  const cs = generaCandidate(rs);
  assert.equal(cs.length, 6);
  assert.ok(cs.some(c => c.nodes.join(',') === '1,2,3,4'));
});

test('02 - nessuna perdita o duplicazione su input ripetuto', () => {
  const rs = [req(1,1,2), req(2,1,2)];
  const a = generaCandidate(rs);
  const b = generaCandidate(rs);
  assert.equal(a.length, 2);
  assert.deepEqual(signature(a), signature(b));
});

test('03 - classi commerciali miste: classe del primo seed', () => {
  const cs = generaCandidate([req(1,1,2,0,1,30,'EXPRESS'), req(2,2,3,10,1,30,'SAVER')]);
  const chained = cs.find(c => c.nodes.join(',') === '1,2,3');
  assert.ok(chained);
  assert.equal(chained.classe, 'EXPRESS');
  assert.deepEqual(chained.seeds, [1,2]);
});

test('04 - input con nodi uguali e ID non validi escluso', () => {
  const cs = generaCandidate([req(1,1,1), req(-2,1,2), req(3,1,2)]);
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0].seeds, [3]);
});

test('05 - limite candidate: 32 richieste concatenate falliscono esplicitamente', () => {
  const rs = Array.from({length:32}, (_,i) => req(i+1,i+1,i+2));
  assert.throws(() => generaCandidate(rs), /Limite 500 candidate/);
});

test('06 - tolleranza nominale 30 minuti', () => {
  assert.equal(TOLLERANZA_MS, min(30));
});

test('07 - richieste in sequenza con orari coerenti: compatibili', () => {
  const rs = [req(1,1,2,0), req(2,2,3,10)];
  const result = valutaRichieste(plan, rs, [1,2], { ...options, mode:'seeds_only' });
  assert.ok(result);
  assert.deepEqual(result.requests.map(r => r.id), [1,2]);
  assert.equal(result.peak, 1);
  assert.equal(result.revenue, 60);
});

test('08 - seconda salita troppo distante nel tempo: incompatibile', () => {
  const rs = [req(1,1,2,0), req(2,2,3,120)];
  assert.equal(valutaRichieste(plan, rs, [1,2], { ...options, mode:'seeds_only' }), null);
});

test('09 - tolleranza al bordo: 60 minuti tra due partenze allo stesso nodo', () => {
  const rs = [req(1,1,2,0), req(2,1,2,60)];
  assert.ok(valutaRichieste(plan, rs, [1,2], { ...options, mode:'seeds_only' }));
  rs[1] = req(2,1,2,61);
  assert.equal(valutaRichieste(plan, rs, [1,2], { ...options, mode:'seeds_only' }), null);
});

test('10 - limite posti su tratte sovrapposte', () => {
  const rs = [req(1,1,3,0,2), req(2,2,3,10,2)];
  assert.equal(valutaRichieste(plan, rs, [1,2], { ...options, mode:'seeds_only', maxPeak:3 }), null);
  const ok = valutaRichieste(plan, rs, [1,2], { ...options, mode:'seeds_only', maxPeak:4 });
  assert.ok(ok);
  assert.equal(ok.peak, 4);
});

test('11 - greedy aggiunge richieste compatibili senza duplicati', () => {
  const rs = [req(1,1,2,0), req(2,2,3,10), req(3,1,3,0)];
  const result = valutaRichieste(plan, rs, [1], { ...options, maxPeak:3 });
  assert.ok(result);
  assert.deepEqual(result.requests.map(r => r.id), [1,2,3]);
});

test('12 - formazioni alternative: seed sempre incluso', () => {
  const rs = [req(1,1,2,0), req(2,2,3,10), req(3,1,3,0)];
  const alts = generaFormazioniAlternative(plan, rs, [1], { ...options, maxFormazioni:20 });
  assert.ok(alts.length >= 1);
  assert.ok(alts.every(a => a.requests.some(r => r.id === 1)));
  const unique = new Set(alts.map(a => a.requests.map(r => r.id).sort((x,y)=>x-y).join(',')));
  assert.equal(unique.size, alts.length);
});

test('13 - qualità individuale: tratta semplice valida', () => {
  const result = verificaQualitaRichieste(plan, [req(1,1,3)]);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('14 - qualità: deviazione eccessiva respinta', () => {
  const r = { ...req(1,1,3), distanza_diretta_km:10 };
  const result = verificaQualitaRichieste(plan, [r]);
  assert.equal(result.ok, false);
  assert.equal(result.motivo, 'DEVIAZIONE_ECCESSIVA');
});

let passed = 0;
console.log('=== POPBUS V2 | REGRESSIONE MODEL | NESSUN DB ===');
for (const {name, fn} of tests) {
  try {
    await fn();
    passed++;
    console.log(`PASS | ${name}`);
  } catch (error) {
    console.error(`FAIL | ${name}`);
    console.error(error.stack || error.message);
  }
}
console.log(`ESITO: ${passed}/${tests.length} PASS`);
if (passed !== tests.length) process.exitCode = 1;
