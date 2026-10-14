import assert from 'node:assert/strict';
import {
  valutaRichieste,
  generaFormazioniAlternative,
  scegliAttivazioni
} from '../services/popbus/v2/model.js';

const BASE = Date.parse('2026-10-20T08:00:00Z');
const plan = {
  nodes: [1, 3, 4], classe: 'STANDARD',
  legs: [{ metres: 10000, seconds: 600 }, { metres: 10000, seconds: 600 }]
};
const request = (id, start, end, pax, minutes, price = 20) => ({
  id, start_node_id: start, end_node_id: end,
  start_datetime: new Date(BASE + minutes * 60000).toISOString(),
  posti_richiesti: pax, prezzo: price, classe: 'STANDARD'
});
let passed = 0;
function test(name, run) {
  try { run(); console.log(`✅ ${name}`); passed++; }
  catch (error) { console.error(`❌ ${name}: ${error.message}`); process.exitCode = 1; }
}
const evaluate = (requests, maxPeak = 10) =>
  valutaRichieste(plan, requests, requests.map(r => r.id), { mode: 'seeds_only', maxPeak });

console.log('=== POPBUS V2 — TEST LIMITI (senza DB) ===');
test('T01: scenario base 9/8 posti', () => {
  const e = evaluate([request(1,1,3,4,0), request(2,1,4,5,0), request(3,3,4,3,10)]);
  assert.ok(e); assert.deepEqual(e.occupancy, [9,8]); assert.equal(e.peak,9);
});
test('T02: scarto di 60 minuti esatti tra richieste allo stesso nodo (finestre che si toccano)', () => {
  const e = evaluate([request(1,1,4,2,0), request(2,1,4,2,60)]);
  assert.ok(e); assert.equal(e.departure, BASE + 30*60000);
});
test('T03: scarto di 61 minuti (finestre incompatibili)', () => {
  assert.equal(evaluate([request(1,1,4,2,0), request(2,1,4,2,61)]), null);
});
test('T04: nodo intermedio alle 08:40, partenza nodo 1 alle 08:00 (differenza prevista 30 min)', () => {
  const e = evaluate([request(1,1,4,2,0), request(2,3,4,2,40)]);
  assert.ok(e); assert.deepEqual(e.occupancy, [2,4]);
});
test('T05: 11 posti simultanei sul primo segmento (rifiutati)', () => {
  assert.equal(evaluate([request(1,1,4,6,0), request(2,1,3,5,0)]), null);
});
test('T06: 12 passeggeri complessivi su segmenti separati (ammessi)', () => {
  const e = evaluate([request(1,1,3,7,0), request(2,3,4,5,10)]);
  assert.ok(e); assert.deepEqual(e.occupancy, [7,5]); assert.equal(e.peak,7);
});
test('T07: richiesta indivisibile da 11 posti (rifiutata)', () => {
  assert.equal(evaluate([request(1,1,4,11,0)]), null);
});
test('T08: ordine salita/discesa invertito (rifiutato)', () => {
  assert.equal(evaluate([request(1,4,1,2,0)]), null);
});
test('T09: formazioni alternative senza superamento capienza', () => {
  const rs = [request(1,1,3,4,0), request(2,1,4,5,0), request(3,3,4,3,10)];
  const alt = generaFormazioniAlternative(plan, rs, [1], {maxFormazioni:80});
  assert.equal(alt.length,4);
  assert.ok(alt.some(a => a.requests.length===3 && a.peak===9));
});

// Test diagnostico: nella tua architettura driver_id è il TITOLARE della flotta.
// Qui controlliamo il comportamento ATTUALE, senza alterarlo.
test('T10: diagnostica due veicoli dello stesso titolare in contemporanea', () => {
  const make = (id, reqId) => ({
    plan, vehicle:{id,driver_id:77,posti_totali:10}, cost:10,
    evaluation:{requests:[{id:reqId}],revenue:30,peak:2,departure:BASE,arrival:BASE+1200000},
    busyStart:BASE-600000, busyEnd:BASE+1800000
  });
  const selected = scegliAttivazioni([make(101,101),make(102,102)]);
  console.log(`   Veicoli distinti stesso titolare: selezionati ${selected.length}/2`);
  assert.equal(selected.length, 2, 'Blocco per driver_id: la flotta non può operare in parallelo');
});
console.log(`\nRisultato: ${passed}/10 test superati`);
if (process.exitCode) console.log('Almeno un test ha rilevato una criticità. Nessun dato modificato.');
