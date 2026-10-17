// TURENTU PIXEL — integrazione incrementale + node-routing, senza DB/HTTP.
// Copiare in tests/pixel_test-integration.mjs
import assert from 'node:assert/strict';
import { createPixelNodeRouter } from '../services/pixel/node-routing.js';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';

// Fixture dei 9 nodi territoriali: coordinate note, non lette dal database.
const nodes = [
  [1, 39.9377853, 18.3194929], [2, 45.468503, 9.1824027],
  [3, 40.6327732, 17.9418724], [4, 41.1171, 16.8719],
  [5, 40.117872, 18.298862], [6, 39.9051765, 18.3644653],
  [7, 40.3522, 18.1755], [8, 39.9302065, 18.3584374],
  [9, 40.4674, 17.2348],
];
const catalog = new Map(nodes.map(([id, lat, lon]) => [id, { id, lat, lon }]));
const durations = new Map([
  ['7>5', 1500], ['5>8', 1200], ['8>6', 600],
  ['3>7', 2400], ['4>3', 4200], ['8>5', 1300], ['5>7', 1600],
]);
let routingCalls = [];
const mockLeg = async (a, b) => {
  const key = `${a.id}>${b.id}`;
  routingCalls.push(key);
  if (!durations.has(key)) throw new Error(`Tratta non ammessa nel fixture: ${key}`);
  // Simulazione: non e' una certificazione di viabilita' reale.
  return { metres: 10000, seconds: durations.get(key) ?? 1800,
    polyline: 'mock-geometry', roadCoincident: false };
};
const routeNodes = createPixelNodeRouter({ leg: mockLeg, getNode: id => catalog.get(id) });
const engine = createIncrementalCorridorEngine({ routeNodes, tolleranzaMinuti: 10 });
const req = (id, from, to, start_datetime) => ({
  id, origine_nodo_territoriale_id: from, destinazione_nodo_territoriale_id: to,
  start_datetime, posti_richiesti: 1, classe: 'STANDARD'
});
let count = 0;
async function test(label, fn) { await fn(); console.log(`OK ${++count}: ${label}`); }

await test('creazione della direttrice territoriale 7>5', async () => {
  const result = await engine.processRequest(req(101, 7, 5, '2026-10-20T09:00:00Z'));
  assert.equal(result.azione, 'creazione');
  assert.deepEqual(engine.getCorridor(result.direttrici[0]).nodes, [7, 5]);
  assert.deepEqual(routingCalls, ['7>5']);
});
const original = engine.listCorridors()[0].id;
await test('estensione a Tricase crea variante e preserva originale', async () => {
  const result = await engine.processRequest(req(102, 7, 8, '2026-10-20T09:00:00Z'));
  assert.equal(result.azione, 'estensione');
  assert.deepEqual(engine.getCorridor(result.direttrici[0]).nodes, [7, 5, 8]);
  assert.deepEqual(engine.getCorridor(original).nodes, [7, 5]);
});
const extended = engine.listCorridors().find(c => c.nodes.join('>') === '7>5>8').id;
await test('aggancio intermedio non richiede nuovo routing', async () => {
  const before = routingCalls.length;
  const result = await engine.processRequest(req(103, 5, 8, '2026-10-20T09:25:00Z'));
  assert.equal(result.azione, 'aggancio');
  assert.deepEqual(result.direttrici, [extended]);
  assert.equal(routingCalls.length, before);
});
await test('fasce temporali calcolate con offset del nodo Maglie', async () => {
  const groups = engine.temporalCandidates(extended);
  assert(groups.some(g => g.richiestaIds.includes(102) && g.richiestaIds.includes(103)));
  assert(groups.every(g => g.preliminare === true));
});
await test('retroestensione da Brindisi crea nuova variante', async () => {
  const result = await engine.processRequest(req(104, 3, 8, '2026-10-20T08:20:00Z'));
  assert.equal(result.azione, 'retroestensione');
  assert.deepEqual(engine.getCorridor(result.direttrici[0]).nodes, [3, 7, 5, 8]);
});
await test('richiesta inversa crea contenitore distinto', async () => {
  const result = await engine.processRequest(req(105, 8, 5, '2026-10-20T11:00:00Z'));
  assert.equal(result.azione, 'creazione');
  assert.deepEqual(engine.getCorridor(result.direttrici[0]).nodes, [8, 5]);
});
await test('richiesta idempotente non richiama il routing', async () => {
  const before = routingCalls.length;
  const result = await engine.processRequest(req(103, 5, 8, '2026-10-20T09:25:00Z'));
  assert.equal(result.azione, 'gia_presente');
  assert.equal(routingCalls.length, before);
});
await test('annullamento rimuove membership ma preserva direttrice', async () => {
  assert.equal(engine.detachRequest(103), true);
  assert.equal(engine.getRequest(103), null);
  assert(!engine.getCorridor(extended).richiestaIds.includes(103));
  assert(engine.getCorridor(extended));
});
await test('nodo territoriale assente blocca nuova direttrice', async () => {
  const before = engine.listCorridors().length;
  await assert.rejects(engine.processRequest(req(106, 7, 999, '2026-10-20T13:00:00Z')),
    /mancante|non valido/);
  assert.equal(engine.listCorridors().length, before);
  assert.equal(engine.getRequest(106), null);
});
console.log(`\nPIXEL INTEGRATION: ${count} test superati. Routing simulato, DB intatto.`);
