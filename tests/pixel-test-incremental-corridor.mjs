import assert from 'node:assert/strict';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';

let calls = 0;
const routeNodes = async nodes => {
  calls++;
  return { verificataRouting: true, legs: nodes.slice(1).map((n, i) => ({
    metres: 12000, seconds: 1200, polyline: `mock-${nodes[i]}-${n}`
  })) };
};
const r = (id, from, to, time = '2026-10-16T09:00:00Z') => ({ id,
  origine_nodo_territoriale_id: from, destinazione_nodo_territoriale_id: to,
  start_datetime: time, posti_richiesti: 1 });
const engine = createIncrementalCorridorEngine({ routeNodes });
let tests = 0;
async function test(name, fn) { await fn(); console.log(`OK ${++tests}: ${name}`); }
await test('nuova richiesta genera direttrice con routing', async () => {
  const x = await engine.processRequest(r(1,7,8));
  assert.equal(x.azione,'creazione'); assert.deepEqual(engine.getCorridor(x.direttrici[0]).nodes,[7,8]);
});
await test('richiesta identica e idempotente', async () => {
  const before = calls; assert.equal((await engine.processRequest(r(1,7,8))).azione,'gia_presente'); assert.equal(calls,before);
});
await test('estensione genera variante, preserva originale', async () => {
  const x = await engine.processRequest(r(2,7,6));
  assert.equal(x.azione,'estensione'); assert.deepEqual(engine.getCorridor(x.direttrici[0]).nodes,[7,8,6]);
  assert.deepEqual(engine.getCorridor('px-1').nodes,[7,8]);
});
await test('aggancio diretto senza nuove chiamate routing', async () => {
  const before=calls; const x=await engine.processRequest(r(3,8,6));
  assert.equal(x.azione,'aggancio'); assert.equal(calls,before);
});
await test('retroestensione crea variante', async () => {
  const x=await engine.processRequest(r(4,3,7)); assert.equal(x.azione,'retroestensione');
});
await test('origine e destinazione invertite non agganciate', async () => {
  const x=await engine.processRequest(r(5,8,7)); assert.equal(x.azione,'creazione');
});
await test('stesso ID con dati diversi viene rifiutato', async () => {
  await assert.rejects(engine.processRequest(r(1,7,5)),/gia presente/);
});
await test('fasce con offset stradali', async () => {
  const groups=engine.temporalCandidates('px-2');
  assert(groups.length>=1); assert(groups.every(g => g.preliminare && g.finestraPartenza));
});
await test('annullamento sgancia senza eliminare direttrice', async () => {
  assert.equal(engine.detachRequest(3),true); assert.equal(engine.getRequest(3),null);
  assert(engine.getCorridor('px-2')); assert.equal(engine.detachRequest(3),false);
});
await test('routing non verificato non crea nuove direttrici', async () => {
  const fail=createIncrementalCorridorEngine({routeNodes:async()=>({verificataRouting:false,legs:[]})});
  await assert.rejects(fail.processRequest(r(90,4,3)),/routing non verificato/);
  assert.equal(fail.listCorridors().length,0);
});
console.log(`\nPIXEL INCREMENTAL: ${tests} test superati. Routing simulato, DB intatto.`);
