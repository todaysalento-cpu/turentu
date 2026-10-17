// TURENTU — collaudo diagnostico PIXEL P2.1 -> POPBUS V2, routing MOCK.
// Salvare in tests/test_pixel_popbus_v2_integrato_readonly.mjs.
// Non importa worker, db, pg o servizi HTTP; nessuna scrittura o attivazione.
import assert from 'node:assert/strict';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { diagnosticaPixelPopbusV2 } from '../services/pixel/pixel-popbus-v2-adapter.js';
import { diagnosticaCicloPixelPopbus } from '../services/pixel/pixel-popbus-cycle-adapter.js';

const base = Date.parse('2030-04-01T12:00:00.000Z');
const iso = mins => new Date(base + mins * 60000).toISOString();
const nodes = [
  { id: 1, lat: 40.10, lon: 18.10 },
  { id: 2, lat: 40.20, lon: 18.20 },
  { id: 3, lat: 40.30, lon: 18.30 },
];
const nodeMap = new Map(nodes.map(n => [n.id, n]));
const leg = (a, b) => ({ metres: 10000, seconds: 600, polyline: `mock-${a}-${b}` });
const routeNodes = async ids => ({ verificataRouting: true, legs: ids.slice(1).map((b, i) => leg(ids[i], b)) });
const road = async (a, b) => {
  if (!a || !b) throw Error('NODO_MOCK_ASSENTE');
  if (Number(a.lat) === Number(b.lat) && Number(a.lon) === Number(b.lon)) return { metres: 0, seconds: 0, roadCoincident: true };
  return { metres: 10000, seconds: 600 };
};
const input = (id, from, to, minute, price = 200) => ({
  id, origine_nodo_territoriale_id: from, destinazione_nodo_territoriale_id: to,
  start_node_id: from, end_node_id: to, start_datetime: iso(minute),
  posti_richiesti: 1, prezzo: price, classe: 'STANDARD',
  classe_percorrenza: 'BASSA', max_fermate_intermedie: 10,
  min_km_tra_fermate: 0, max_deviazione_pct: 100,
});
const requests = [
  input(1, 1, 2, 0),
  input(2, 2, 3, 10),
  input(3, 1, 3, 0),
  input(4, 1, 3, 180), // incompatibile temporalmente con le prime tre
];
const engine = createIncrementalCorridorEngine({
  routeNodes, abilitaVariantiP1: true, maxVariantiPerRichiesta: 4, maxNodiVariante: 8,
});
const checks = [];
function check(name, fn) {
  try { fn(); checks.push({ test: name, esito: 'PASS' }); }
  catch (e) { checks.push({ test: name, esito: 'FAIL', dettaglio: e.message }); }
}
for (const r of requests) await engine.processRequest(r);
const corridors = engine.listCorridors();
const corridor = corridors.find(c => c.nodes.join(',') === '1,2,3' && [1, 2, 3, 4].every(id => c.richiestaIds.includes(id)));
check('PIXEL genera una direttrice 1->2->3 con appartenenza completa', () => assert.ok(corridor));
let v2 = [], cycle = null;
if (corridor) {
  v2 = await diagnosticaPixelPopbusV2({ engine, direttriceId: corridor.id, richieste: requests });
  check('Adapter V2 produce istanze diagnostiche', () => assert.ok(v2.length > 0));
  check('Adapter V2 riconosce almeno un gruppo compatibile 1+2+3', () =>
    assert.ok(v2.some(x => x.compatibilePopbus && [1,2,3].every(id => x.richiestaIds.includes(id)) && !x.richiestaIds.includes(4))));
  check('Adapter V2 non certifica attivazione', () => assert.ok(v2.every(x => x.attivabile === false)));
  const vehicle = { id: 101, driver_id: 501, posti_totali: 4, euro_km: 0.5,
    lat: nodeMap.get(1).lat, lon: nodeMap.get(1).lon };
  cycle = await diagnosticaCicloPixelPopbus({
    engine, missioni: [{ corridorId: corridor.id, requestIds: [1,2,3] }],
    richieste: requests, vehicle, nodes, road,
    now: base - 86400000,
    validateVehicle: async () => true,
    validateCandidate: async () => true,
  });
  check('Adapter cicli valida missione economicamente sostenibile', () =>
    assert.equal(cycle.ok, true, JSON.stringify(cycle)));
  check('Adapter cicli include il ritorno ed evita attivazione automatica', () => {
    assert.equal(cycle.attivabile, false);
    assert.ok(cycle.economia);
    assert.ok(cycle.busyEnd > cycle.busyStart);
  });
  const overloaded = await diagnosticaCicloPixelPopbus({
    engine, missioni: [{ corridorId: corridor.id, requestIds: [1,2,3] }],
    richieste: requests, vehicle: { ...vehicle, id: 102, posti_totali: 1 },
    nodes, road, now: base - 86400000,
  });
  check('Capienza insufficiente respinta', () => {
    assert.equal(overloaded.ok, false);
    assert.equal(overloaded.motivo, 'COMPATIBILITA_NON_SUPERATA');
  });
  const duplicate = await diagnosticaCicloPixelPopbus({
    engine, missioni: [{ corridorId: corridor.id, requestIds: [1,1] }],
    richieste: requests, vehicle, nodes, road, now: base - 86400000,
  });
  check('Richieste duplicate respinte', () => assert.equal(duplicate.motivo, 'RICHIESTA_DUPLICATA'));
}
const output = {
  test: 'PIXEL P2.1 -> POPBUS V2: diagnostica reale con routing MOCK',
  limiti: ['Nessuna query DB', 'Nessuna attivazione', 'Non valida il worker transazionale',
    'Routing simulato: non certifica distanze o tempi stradali reali'],
  dati: { richieste: requests.length, direttrici: corridors.length,
    direttriceTest: corridor?.id ?? null, istanzeV2: v2.length },
  checks, ciclo: cycle && { ok: cycle.ok, motivo: cycle.motivo ?? null,
    attivabile: cycle.attivabile, validazionePreliminare: cycle.validazionePreliminare ?? false },
  passed: checks.filter(x => x.esito === 'PASS').length,
  failed: checks.filter(x => x.esito === 'FAIL').length,
};
console.log(JSON.stringify(output, null, 2));
if (output.failed) process.exitCode = 1;
