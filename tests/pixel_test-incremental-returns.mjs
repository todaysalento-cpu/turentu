import assert from 'node:assert/strict';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';

let calls = 0;
const routeNodes = async nodes => {
  calls++;
  return { verificataRouting: true, legs: nodes.slice(1).map((n,i) => ({
    metres: 15000, seconds: 1800, polyline: `mock-${nodes[i]}-${n}`
  })) };
};
const r = (id, from, to, time) => ({ id,
  origine_nodo_territoriale_id: from,
  destinazione_nodo_territoriale_id: to,
  start_datetime: `2026-10-16T${time}:00Z`, posti_richiesti: 1
});
const engine = createIncrementalCorridorEngine({ routeNodes, tolleranzaMinuti: 15 });
let passed = 0;
const test = async (name, fn) => { await fn(); console.log(`OK ${++passed}: ${name}`); };
await test('crea direttrice Tiggiano-Maglie-Lecce', async () => {
  await engine.processRequest(r(1,6,5,'09:00'));
  const result = await engine.processRequest(r(2,6,7,'09:00'));
  assert.equal(result.azione,'estensione');
});
await test('registra richieste inverse indipendenti', async () => {
  await engine.processRequest(r(3,5,6,'09:45'));
  await engine.processRequest(r(4,5,6,'10:45'));
  assert.ok(engine.getRequest(3) && engine.getRequest(4));
});
const corridor = engine.listCorridors().find(c => c.nodes.join('>') === '6>5>7');
assert.ok(corridor);
await test('Maglie ha finestre con inversione Maglie e Lecce', async () => {
  const candidates = await engine.temporalCandidatesWithReturns(corridor.id, {bufferMinuti:10});
  const windows = candidates.flatMap(x => x.finestreRitornoPerNodo[5]);
  assert.ok(windows.some(w => w.inversioneNodoId === 5 && w.richiestaIds.includes(3)));
  assert.ok(windows.some(w => w.inversioneNodoId === 7 && w.richiestaIds.includes(4)));
});
await test('routing inverso riutilizzato da cache', async () => {
  const before = calls;
  await engine.temporalCandidatesWithReturns(corridor.id);
  assert.equal(calls,before);
});
await test('annullamento rimuove richiesta dalle finestre', async () => {
  assert.equal(engine.detachRequest(3),true);
  const windows = (await engine.temporalCandidatesWithReturns(corridor.id))
    .flatMap(x => x.finestreRitornoPerNodo[5]);
  assert.ok(windows.every(w => !w.richiestaIds.includes(3)));
});
console.log(`PIXEL INCREMENTAL RETURNS: ${passed} test superati; DB intatto`);
