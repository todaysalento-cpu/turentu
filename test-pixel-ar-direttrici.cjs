'use strict';
// Test isolato PIXEL: nessun DB, HTTP, Stripe o scrittura.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const file = path.join(process.cwd(), 'services', 'pixel', 'incremental-corridor-engine.js');
  const { createIncrementalCorridorEngine } = await import(pathToFileURL(file).href);
  const routeCalls = [];
  const routeNodes = async nodes => {
    routeCalls.push([...nodes]);
    return { verificataRouting: true, legs: nodes.slice(1).map(() => ({
      metres: 12000, seconds: 900, polyline: 'test-polyline-non-reale', roadCoincident: false
    })) };
  };
  const leg = { metres: 12000, seconds: 900, polyline: 'test-polyline-non-reale', roadCoincident: false };
  const engine = createIncrementalCorridorEngine({
    routeNodes,
    initialCorridors: [{ id: 'px-1', nodes: [8, 5, 7], legs: [leg, leg], richiestaIds: [] }],
    abilitaVariantiP1: true,
    tolleranzaMinuti: 30
  });
  const date = new Date(Date.now() + 86400000).toISOString();
  const makeReq = (id, a, b) => ({ id, origine_nodo_territoriale_id: a,
    destinazione_nodo_territoriale_id: b, start_datetime: date, posti_richiesti: 1, classe: 'STANDARD' });

  const outbound = await engine.processRequest(makeReq(900001, 8, 7));
  assert.equal(outbound.azione, 'aggancio');
  assert.deepEqual(engine.getCorridor('px-1').nodes, [8, 5, 7]);
  console.log('PASS 1: richiesta 8->7 agganciata alla direttrice esistente 8>5>7');

  const returning = await engine.processRequest(makeReq(900002, 7, 8));
  const corridors = engine.listCorridors();
  const inverse = corridors.find(c => c.nodes.join('>') === '7>8');
  assert.ok(inverse, 'Direttrice inversa 7>8 non creata');
  assert.ok(inverse.richiestaIds.includes(900002), 'Richiesta ritorno non associata');
  assert.ok(!engine.getCorridor('px-1').richiestaIds.includes(900002), 'Ritorno associato erroneamente all andata');
  assert.ok(routeCalls.some(nodes => nodes.join('>') === '7>8'), 'Routing inverso non verificato');
  console.log('PASS 2: richiesta 7->8 genera direttrice indipendente con routing verificato');
  console.log('PASS 3: ritorno non inserito nella direttrice 8>5>7');
  console.log('Esito:', JSON.stringify({ andata: outbound.azione, ritorno: returning.azione,
    direttrici: corridors.map(c => ({ nodes: c.nodes, richieste: c.richiestaIds })),
    routeCalls }, null, 2));
  console.log('PIXEL A/R TEST SUPERATO (routing simulato, nessuna persistenza DB).');
}
main().catch(err => { console.error('PIXEL A/R TEST FALLITO:', err.stack || err); process.exitCode = 1; });
