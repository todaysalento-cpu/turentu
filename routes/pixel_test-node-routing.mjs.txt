import assert from 'node:assert/strict';
import { createPixelNodeRouter } from '../services/pixel/node-routing.js';

const catalog = new Map([
  [7, { id: 7, lat: 40.3522, lon: 18.1755 }],
  [5, { id: 5, lat: 40.117872, lon: 18.298862 }],
  [8, { id: 8, lat: 39.9302065, lon: 18.3584374 }],
]);
let calls = [];
const fakeLeg = async (a, b) => {
  calls.push(`${a.id}>${b.id}`);
  return { metres: 10000, seconds: 900, polyline: 'valid-mock-polyline', roadCoincident: false };
};
const routeNodes = createPixelNodeRouter({ leg: fakeLeg, getNode: id => catalog.get(id) });
let n = 0;
async function test(name, fn) { await fn(); console.log(`OK ${++n}: ${name}`); }
await test('percorso ordinato, tratte e cumulativi', async () => {
  const result = await routeNodes([7, 5, 8]);
  assert.deepEqual(calls, ['7>5', '5>8']);
  assert.equal(result.verificataRouting, true);
  assert.deepEqual(result.cumulativeSeconds, [0, 900, 1800]);
  assert.deepEqual(result.cumulativeMetres, [0, 10000, 20000]);
});
await test('verso opposto non invertito automaticamente', async () => {
  calls = [];
  await routeNodes([8, 5]);
  assert.deepEqual(calls, ['8>5']);
});
await test('nodo mancante rifiutato', async () => {
  await assert.rejects(routeNodes([7, 999]), /mancante/);
});
await test('nodi duplicati rifiutati', async () => {
  await assert.rejects(routeNodes([7, 7]), /ripetuti/);
});
await test('limite nodi rispettato prima del routing', async () => {
  const small = createPixelNodeRouter({ leg: fakeLeg, getNode: id => catalog.get(id), maxNodes: 2 });
  await assert.rejects(small([7, 5, 8]), /numero nodi/);
});
await test('tratta priva di geometria rifiutata', async () => {
  const bad = createPixelNodeRouter({ leg: async () => ({ metres: 10, seconds: 5 }), getNode: id => catalog.get(id) });
  await assert.rejects(bad([7, 5]), /non verificata/);
});
await test('errore del provider propagato', async () => {
  const bad = createPixelNodeRouter({ leg: async () => { throw new Error('provider offline'); }, getNode: id => catalog.get(id) });
  await assert.rejects(bad([7, 5]), /provider offline/);
});
await test('routing valido coincidente accettato', async () => {
  const coincident = createPixelNodeRouter({ leg: async () => ({ metres: 0, seconds: 0, roadCoincident: true, polyline: 'mock' }), getNode: id => catalog.get(id) });
  assert.equal((await coincident([7, 5])).legs[0].roadCoincident, true);
});
console.log(`\nPIXEL NODE ROUTING: ${n} test superati. Routing simulato, DB intatto.`);
