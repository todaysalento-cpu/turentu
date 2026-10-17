/**
 * TURENTU POPBUS — collaudo diagnostico di tre missioni.
 * Salvare in tests/test_popbus_ciclo_3_missioni.mjs
 * Eseguire dalla root: node tests/test_popbus_ciclo_3_missioni.mjs
 *
 * NON importa worker, NON usa pool DB, NON crea attivazioni/corse.
 * Usa routing stradale reale attraverso planner.leg(): puo' effettuare
 * richieste HTTP al provider di mappe e consumare quote API.
 */
import assert from 'node:assert/strict';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { diagnosticaCicloPixelPopbus } from '../services/pixel/pixel-popbus-cycle-adapter.js';
import { leg } from '../services/popbus/v2/planner.js';

const nodes = [
  { id: 7, nome: 'Lecce', lat: 40.3515, lon: 18.1750 },
  { id: 5, nome: 'Maglie', lat: 40.1208, lon: 18.2973 },
  { id: 8, nome: 'Tricase', lat: 39.9302, lon: 18.3584 }
];
const byNode = new Map(nodes.map(n => [n.id, n]));
const road = (a, b) => leg(a, b);
const routeNodes = async ids => ({
  verificataRouting: true,
  legs: await Promise.all(ids.slice(1).map((id, i) =>
    road(byNode.get(ids[i]), byNode.get(id))))
});
const engine = createIncrementalCorridorEngine({ routeNodes });
const tomorrow = new Date(Date.now() + 3 * 86400000);
tomorrow.setUTCHours(9, 0, 0, 0);
const firstStart = tomorrow.getTime();

// Si pianificano tre corse distinte per orario richiesto, NON tre record DB.
// Le partenze successive devono essere calcolate sulla durata stradale reale.
const r1 = await road(nodes[0], nodes[1]);
const r2 = await road(nodes[1], nodes[2]);
const transferBufferMs = 20 * 60000;
const t1 = firstStart;
const t2 = t1 + r1.seconds * 1000 + transferBufferMs;
const t3 = t2 + r2.seconds * 1000 + transferBufferMs;

const requests = [
  { id: 910001, origine_nodo_territoriale_id: 7, destinazione_nodo_territoriale_id: 5,
    start_node_id: 7, end_node_id: 5, start_datetime: new Date(t1).toISOString(),
    posti_richiesti: 2, prezzo: 90, classe: 'STANDARD' },
  { id: 910002, origine_nodo_territoriale_id: 5, destinazione_nodo_territoriale_id: 8,
    start_node_id: 5, end_node_id: 8, start_datetime: new Date(t2).toISOString(),
    posti_richiesti: 3, prezzo: 90, classe: 'STANDARD' },
  { id: 910003, origine_nodo_territoriale_id: 8, destinazione_nodo_territoriale_id: 7,
    start_node_id: 8, end_node_id: 7, start_datetime: new Date(t3).toISOString(),
    posti_richiesti: 2, prezzo: 90, classe: 'STANDARD' }
];
const missioni = [];
for (const r of requests) {
  const out = await engine.processRequest(r);
  const corridorId = out.direttrici.find(id => {
    const c = engine.getCorridor(id);
    return c?.nodes.length === 2 &&
      c.nodes[0] === r.start_node_id && c.nodes[1] === r.end_node_id;
  });
  assert.ok(corridorId, `Nessun corridoio esatto per richiesta ${r.id}`);
  missioni.push({ corridorId, requestIds: [r.id] });
}
const vehicle = {
  id: 353, driver_id: 2, posti_totali: 10, euro_km: 0.60,
  // Base sintetica presso Tricase; non rappresenta il record DB del veicolo.
  lat: 39.9302, lon: 18.3584
};

const diagnostic = await diagnosticaCicloPixelPopbus({
  engine, missioni, richieste: requests, vehicle, nodes, road,
  now: Date.now(), maxWaitMin: 180
});
console.log('\n=== TEST POPBUS CICLO TRE MISSIONI (SOLA DIAGNOSTICA) ===');
console.log(JSON.stringify({
  ok: diagnostic.ok, motivo: diagnostic.motivo ?? null,
  stato: diagnostic.stato ?? null,
  validazionePreliminare: diagnostic.validazionePreliminare ?? false,
  attivabile: diagnostic.attivabile ?? false,
  veicoloId: diagnostic.veicoloId ?? null,
  numeroMissioni: diagnostic.missioni?.length ?? 0,
  numeroRichieste: diagnostic.richieste?.length ?? 0,
  busyStart: diagnostic.busyStart ? new Date(diagnostic.busyStart).toISOString() : null,
  busyEnd: diagnostic.busyEnd ? new Date(diagnostic.busyEnd).toISOString() : null,
  trasferimenti: diagnostic.trasferimenti ?? [],
  economia: diagnostic.economia ?? null,
  dettaglio: diagnostic.dettaglio ?? null
}, null, 2));

assert.equal(diagnostic.ok, true, `Ciclo respinto: ${diagnostic.motivo ?? 'ignoto'}`);
assert.equal(diagnostic.missioni.length, 3);
assert.equal(diagnostic.richieste.length, 3);
assert.equal(diagnostic.attivabile, false, 'La diagnostica non deve attivare corse');
assert.equal(diagnostic.validazionePreliminare, false,
  'Senza callback reali non deve dichiarare validazione completa');
assert.equal(diagnostic.missioni[0].nodes[0], 7);
assert.equal(diagnostic.missioni[2].nodes.at(-1), 7);
assert.ok(diagnostic.busyEnd > diagnostic.busyStart);
assert.ok(diagnostic.economia.economicamenteAttivabile);
console.log('PASS: tre missioni concatenate, ritorno incluso nel costo, nessuna attivazione.');
console.log('NOTA: turni ricorrenti, conflitti DB e corsa unica NON sono certificati da questo test.');
