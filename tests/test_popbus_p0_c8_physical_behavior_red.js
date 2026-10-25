// TURENTU - P0-C8 adapter: test COMPORTAMENTALE RED per contratto fisico V2.
// Copiare in tests/test_popbus_p0_c8_physical_behavior_red.js
// Eseguire dalla root: node tests\test_popbus_p0_c8_physical_behavior_red.js
// Importa il vero adapter e il vero preflight puro. Nessun DB, nessuna scrittura, LIVE NO.
import assert from 'node:assert/strict';
import { preparaCicloPixelPerPersistenza } from '../services/popbus/v2/popbus-p0-c8-adapter.js';

const clone = x => structuredClone(x);
const T0 = Date.parse('2027-04-01T17:00:00.000Z');
const seconds = [50, 138, 50, 662, 50, 139, 50];
const nodes = [14, 14, 15, 15, 15, 15, 14, 14];
const coordinates = nodes.map(id => ({ id, lat: id === 14 ? 40.121583 : 40.1258486502909,
  lon: id === 14 ? 18.305914 : 18.299920672780097 }));
const legs = seconds.map((s, i) => ({ seconds: s, metres: [0,869,0,0,0,882,0][i], polyline: `leg-${i}` }));
const times = [0];
for (const s of seconds) times.push(times.at(-1) + s * 1000);
const ms = i => T0 + times[i];

function fixture() {
  const plan = {
    tipoPiano: 'CICLO_PIXEL_CORSA_UNICA_V1', veicoloId: 71,
    nodes: clone(nodes), coordinates: clone(coordinates), legs: clone(legs),
    busyStart: new Date(T0 - 300000).toISOString(),
    busyEnd: new Date(ms(7) + 300000).toISOString(),
    missioni: [
      { ordine: 1, startIndex: 0, endIndex: 3, partenza: ms(0), arrivo: ms(3), richieste: [900001] },
      { ordine: 2, startIndex: 4, endIndex: 7, partenza: ms(4), arrivo: ms(7), richieste: [900002] }
    ],
    evaluation: {
      departure: T0, arrival: ms(7), times: clone(times), peak: 1,
      requests: [ { id: 900001, start: 0, end: 2 }, { id: 900002, start: 4, end: 6 } ]
    }
  };
  const richiesteBloccate = [
    { id: 900001, stato: 'in_lavorazione', corsa_id: null, cliente_id: 81,
      posti_richiesti: 1, prezzo: 11, start_datetime: new Date(ms(0)).toISOString() },
    { id: 900002, stato: 'in_lavorazione', corsa_id: null, cliente_id: 82,
      posti_richiesti: 1, prezzo: 11, start_datetime: new Date(ms(4)).toISOString() }
  ];
  const opportunitaMissioni = [
    { pixelOpportunitaId: 501, corridoioPixelId: 'pixel-engine-1' },
    { pixelOpportunitaId: 502, corridoioPixelId: 'pixel-engine-2' }
  ];
  return { plan, richiesteBloccate, opportunitaMissioni, veicoloId: 71, postiTotali: 4,
    fingerprintRichiesta: r => `fingerprint-${r.id}`, economia: { economicamenteAttivabile: true } };
}
function v2() {
  const f = fixture();
  f.plan.schemaVersion = 2;
  f.plan.tipoItinerario = 'FERMATE_FISICHE';
  Object.assign(f.opportunitaMissioni[0], {
    pixelDirettriceId: 601, pixelVersione: 3, nodiTerritoriali: [5, 6]
  });
  Object.assign(f.opportunitaMissioni[1], {
    pixelDirettriceId: 602, pixelVersione: 4, nodiTerritoriali: [6, 5]
  });
  return f;
}
const run = f => preparaCicloPixelPerPersistenza(f);
let v1Pass = 0, v1Fail = 0, v2Pass = 0, v2Red = 0;
function baseline(label, fn) {
  try { fn(); v1Pass++; console.log(`PASS V1 - ${label}`); }
  catch (e) { v1Fail++; console.log(`FAIL V1 - ${label}: ${e.message}`); }
}
function contract(label, fn) {
  try { fn(); v2Pass++; console.log(`PASS V2 - ${label}`); }
  catch (e) { v2Red++; console.log(`RED  V2 - ${label}: ${e.message}`); }
}
function mustReject(f, label) {
  let rejected = false;
  try { run(f); } catch (e) {
    // Il rifiuto deve provenire dalla validazione dell'adapter, non da un TypeError.
    if (!String(e.message).startsWith('P0-C8 ADAPTER:')) throw e;
    rejected = true;
  }
  assert.ok(rejected, `${label}: l'adapter ha accettato metadati PIXEL V2 invalidi`);
}

console.log('=== TURENTU - ADAPTER P0-C8 V1/V2 COMPORTAMENTALE RED ===');
baseline('piano V1 valido e 2 missioni persistibili', () => {
  const out = run(fixture());
  assert.equal(out.missioniPersistibili.length, 2);
  assert.deepEqual(out.missioniPersistibili.map(m => m.pixelOpportunitaId), [501, 502]);
  assert.equal(out.piano.attivabile, false);
});
baseline('mapping fisico e indici locali invariati', () => {
  const out = run(fixture());
  assert.deepEqual(out.missioniPersistibili[0].nodes, nodes.slice(0, 4));
  assert.deepEqual(out.missioniPersistibili[1].nodes, nodes.slice(4, 8));
  assert.deepEqual(out.missioniPersistibili[0].legs, legs.slice(0, 3));
  assert.deepEqual(out.missioniPersistibili[1].legs, legs.slice(4, 7));
  assert.deepEqual(out.missioniPersistibili.map(m => m.requests), [
    [{ id: 900001, start: 0, end: 2 }], [{ id: 900002, start: 0, end: 2 }]
  ]);
});
baseline('economia non verificata viene respinta', () => {
  const f = fixture(); f.economia.economicamenteAttivabile = false;
  assert.throws(() => run(f), /ciclo non economicamente attivabile/);
});

contract('V2 propaga identita PIXEL, versione e nodi territoriali distinti', () => {
  const out = run(v2());
  const a = out.missioniPersistibili[0], b = out.missioniPersistibili[1];
  for (const [m, expected] of [[a, [501, 601, 3, 'pixel-engine-1', [5,6]]],
                               [b, [502, 602, 4, 'pixel-engine-2', [6,5]]]]) {
    assert.equal(m.pixelOpportunitaId, expected[0]);
    assert.equal(m.pixelDirettriceId, expected[1]);
    assert.equal(m.pixelVersione, expected[2]);
    assert.equal(m.corridoioPixelId, expected[3]);
    assert.deepEqual(m.nodiTerritoriali, expected[4]);
    assert.equal(m.schemaVersion, 2);
    assert.equal(m.tipoItinerario, 'FERMATE_FISICHE');
  }
  assert.deepEqual(a.nodes, [14,14,15,15]);
  assert.deepEqual(b.nodes, [15,15,14,14]);
});
contract('V2 conserva marcatura del piano globale', () => {
  const out = run(v2());
  assert.equal(out.piano.schemaVersion, 2);
  assert.equal(out.piano.tipoItinerario, 'FERMATE_FISICHE');
});
contract('V2 rifiuta nodiTerritoriali assenti', () => {
  const f = v2(); delete f.opportunitaMissioni[0].nodiTerritoriali;
  mustReject(f, 'nodiTerritoriali assenti');
});
contract('V2 rifiuta nodiTerritoriali invalidi', () => {
  const f = v2(); f.opportunitaMissioni[1].nodiTerritoriali = [6, 0];
  mustReject(f, 'nodiTerritoriali invalidi');
});
contract('V2 rifiuta pixelDirettriceId assente', () => {
  const f = v2(); delete f.opportunitaMissioni[0].pixelDirettriceId;
  mustReject(f, 'pixelDirettriceId assente');
});
contract('V2 rifiuta pixelVersione assente', () => {
  const f = v2(); delete f.opportunitaMissioni[0].pixelVersione;
  mustReject(f, 'pixelVersione assente');
});
contract('V2 rifiuta engine ID mancante', () => {
  const f = v2(); delete f.opportunitaMissioni[0].corridoioPixelId;
  mustReject(f, 'engine ID mancante');
});

console.log(`\nV1: ${v1Pass}/3 PASS, ${v1Fail} FAIL | V2: ${v2Pass}/7 PASS, ${v2Red} RED`);
console.log('Test puro: DB writes 0; LIVE NO.');
if (v1Fail) process.exitCode = 2;
else if (v2Red) { console.log('RED ATTESO prima della modifica dell adapter.'); process.exitCode = 1; }
else console.log('GREEN: eseguire poi test negativi aggiuntivi.');
