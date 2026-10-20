import assert from 'node:assert/strict';
import { generaFormazioniArSafe } from '../services/popbus/v2/pixel-ar-safe-formations.js';
import { generaFormazioniAlternative, valutaRichieste } from '../services/popbus/v2/model.js';

// Test isolati sul contratto del wrapper, senza database o routing.
const plan = { nodes: [1,2], legs: [{ metres: 1000, seconds: 120, roadCoincident: false }] };
const when = new Date(Date.now() + 86400000).toISOString();
const req = (id, ar = false, tratta = null) => ({ id, ar_vincolata: ar, ar_tratta: tratta,
  ar_group_id: ar ? '11111111-1111-4111-8111-111111111111' : null,
  start_node_id: 1, end_node_id: 2, start_datetime: when,
  posti_richiesti: 1, prezzo: 20, stato: 'in_attesa', corsa_id: null });
const registry = { arPairs: [{andata: 101, ritorno: 201}], esclusiIds: [] };
const run = (requests, seeds, registro = registry, overrides = {}) => generaFormazioniArSafe({
  plan, requests, seeds, registro, generaFormazioniAlternative, valutaRichieste,
  maxSeeds: 100, maxFormazioni: 500, ...overrides
});
const has = (result, ids) => result.formazioni.some(f => {
  const found = f.requests.map(r => Number(r.id)).sort((a,b)=>a-b);
  return JSON.stringify(found) === JSON.stringify([...ids].sort((a,b)=>a-b));
});
let passed = 0;
function test(name, fn) { fn(); console.log('PASS', name); passed++; }

test('andata locale con ritorno in altra opportunita', () => {
  const result = run([req(101,true,'andata'),req(1)], [101,1]);
  assert.ok(has(result,[101,1]));
});
test('ritorno locale con andata in altra opportunita', () => {
  const result = run([req(201,true,'ritorno'),req(2)], [201,2]);
  assert.ok(has(result,[201,2]));
});
test('fallback solo ordinario in opportunita andata', () => {
  const result = run([req(101,true,'andata'),req(1),req(3)], [101,1,3]);
  assert.ok(has(result,[1,3]));
});
test('fallback solo ordinario in opportunita ritorno', () => {
  const result = run([req(201,true,'ritorno'),req(2),req(4)], [201,2,4]);
  assert.ok(has(result,[2,4]));
});
test('coppia nella stessa opportunita', () => {
  const result = run([req(101,true,'andata'),req(201,true,'ritorno')],[101,201]);
  assert.ok(has(result,[101,201]));
});
test('A/R esclusa non blocca ordinaria', () => {
  const result = run([req(101,true,'andata'),req(1)],[101,1],
    {arPairs:[],esclusiIds:[101]});
  assert.ok(has(result,[1]));
  assert.ok(result.formazioni.every(f=>f.requests.every(r=>r.id!==101)));
});
test('A/R non registrata fallisce', () => {
  assert.throws(()=>run([req(101,true,'andata')],[101],{arPairs:[],esclusiIds:[]}),/A\/R non registrata/);
});
test('tratta A/R incoerente fallisce', () => {
  assert.throws(()=>run([req(101,true,'ritorno')],[101]),/tratta A\/R incoerente/);
});
console.log(`PIXEL_AR_SAFE_FORMATIONS_ACCEPTANCE: ${passed}/8 passed`);
