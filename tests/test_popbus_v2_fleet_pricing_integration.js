// TURENTU POPBUS V2 — TEST INTEGRAZIONE FLEET PRICING
// SOLO SHADOW: dati sintetici, nessuna query DB, nessuna scrittura, nessun worker.
// Salvare in tests/test_popbus_v2_fleet_pricing_integration.js
import assert from 'node:assert/strict';
import { generaCandidatiFlotta } from '../services/popbus/v2/fleet-candidates.js';
import { creaValidatoriFlotta } from '../services/popbus/v2/fleet-validators.js';

const H = 3600000;
const future = new Date(Date.now() + 48 * H);
future.setUTCMinutes(0, 0, 0);
const t0 = future.getTime();
const nodes = [1, 2, 3, 4].map(id => ({ id, lat: 40, lon: 18 + id / 100 }));
const vehicle = { id: 900, lat: 40, lon: 18, posti_totali: 4, euro_km: 1 };
const requests = [
  { id: 101, start_node_id: 1, end_node_id: 2, start_datetime: new Date(t0).toISOString(), posti_richiesti: 2, prezzo: 50, classe: 'STANDARD' },
  { id: 102, start_node_id: 3, end_node_id: 4, start_datetime: new Date(t0 + 40 * 60000).toISOString(), posti_richiesti: 2, prezzo: 50, classe: 'STANDARD' }
];
// Routing sintetico e deterministico: le distanze sono intenzionalmente artificiali.
const road = async (a, b) => {
  const x = Math.round((Number(a.lon) - 18) * 100);
  const y = Math.round((Number(b.lon) - 18) * 100);
  const steps = Math.abs(x - y);
  return steps === 0 ? { metres: 0, seconds: 0, roadCoincident: true }
    : { metres: steps * 5000, seconds: steps * 600 };
};
const baseOpts = { now: Date.now(), strict: true, maxWaitMin: 180 };
let passed = 0;
async function test(name, fn) {
  await fn(); passed++;
  console.log(`✅ ${name}`);
}
function validators(overrides = {}) {
  return creaValidatoriFlotta({
    now: Date.now(),
    checkShift: async () => true,
    checkConflicts: async () => true,
    checkPayments: async () => true,
    checkQuality: async () => true,
    checkRadius: async () => true,
    ...overrides
  });
}
function input(v = validators(), rs = requests, vs = [vehicle]) {
  return { requests: rs, nodes, vehicles: vs, road,
    validateVehicle: v.validateVehicle, validateCandidate: v.validateCandidate };
}
const result = await generaCandidatiFlotta(input(), baseOpts);
const single = result.candidati.find(c => c.tipo_candidato === 'MISSIONE_SINGOLA');
const chain = result.candidati.find(c => c.tipo_candidato === 'CATENA');
await test('Missioni singole e catena generate', () => {
  assert.equal(result.candidati.length, 3);
  assert.ok(single && chain);
  assert.equal(chain.missioni, 2);
  assert.deepEqual(chain.richieste, [[101], [102]]);
});
await test('Commissione 15% applicata una sola volta alla catena', () => {
  assert.equal(chain.ricavo_euro, 100);
  assert.equal(chain.commissione_turentu_euro, 15);
  assert.equal(chain.ricavo_netto_euro, 85);
});
await test('Un solo avvicinamento, trasferimento e ritorno finale', () => {
  // base->1 = 5 km, 1->2 = 5, 2->3 = 5, 3->4 = 5, 4->base = 20.
  assert.equal(chain.km_totali, 40);
  assert.equal(chain.costo_completo_euro, 40);
  assert.equal(chain.margine_ciclo_con_attesa_euro, 45);
});
await test('Validatori completi riconoscono candidati preliminarmente validati', () => {
  assert.equal(result.diagnostica.candidatiValidati, 3);
  assert.equal(result.diagnostica.nonValidati, 0);
  assert.ok(result.candidati.every(c => c.validazione_preliminare === true));
  assert.equal(result.utilizzabiliPerAttivazione, false);
});
await test('Validator rifiuta manomissione del margine', async () => {
  const v = validators();
  const original = await generaCandidatiFlotta({ ...input(v), validateCandidate: async (c, ctx) => {
    if (c.tipo_candidato === 'CATENA') {
      assert.equal(await v.validateCandidate({ ...c, margine_ciclo_con_attesa_euro: c.margine_ciclo_con_attesa_euro + 1 }, ctx), false);
    }
    return v.validateCandidate(c, ctx);
  } }, baseOpts);
  assert.ok(original.candidati.some(c => c.tipo_candidato === 'CATENA'));
  assert.ok(v.diagnostics().perMotivo.CONTABILITA_INCOERENTE >= 1);
});
await test('Validator rifiuta manomissione della commissione', async () => {
  const v = validators();
  await generaCandidatiFlotta({ ...input(v), validateCandidate: async (c, ctx) => {
    assert.equal(await v.validateCandidate({ ...c, commissione_turentu_euro: 0 }, ctx), false);
    return v.validateCandidate(c, ctx);
  } }, baseOpts);
  assert.ok(v.diagnostics().perMotivo.CONTABILITA_INCOERENTE >= 1);
});
await test('Pagamento negato blocca tutti i candidati', async () => {
  const v = validators({ checkPayments: async () => false });
  const r = await generaCandidatiFlotta(input(v), baseOpts);
  assert.equal(r.candidati.length, 0);
  assert.ok(r.diagnostica.scartiCommerciali > 0);
});
await test('Conflitto veicolo blocca tutti i candidati', async () => {
  const v = validators({ checkConflicts: async () => false });
  const r = await generaCandidatiFlotta(input(v), baseOpts);
  assert.equal(r.candidati.length, 0);
  assert.ok(r.diagnostica.scartiTurniConflitti > 0);
});
await test('Adattatore qualità mancante: fail closed', async () => {
  const v = validators({ checkQuality: undefined });
  const r = await generaCandidatiFlotta(input(v), baseOpts);
  assert.equal(r.candidati.length, 0);
  assert.ok(v.diagnostics().adattatoriMancanti.includes('checkQuality'));
});
await test('Margine netto negativo: nessun candidato', async () => {
  const cheap = requests.map(r => ({ ...r, prezzo: 1 }));
  const r = await generaCandidatiFlotta(input(validators(), cheap), baseOpts);
  assert.equal(r.candidati.length, 0);
});
await test('Capienza insufficiente: nessun candidato', async () => {
  const small = { ...vehicle, posti_totali: 1 };
  const r = await generaCandidatiFlotta(input(validators(), requests, [small]), baseOpts);
  assert.equal(r.candidati.length, 0);
});
await test('Nessun validatore: solo candidati non validati, mai attivabili', async () => {
  const r = await generaCandidatiFlotta({ requests, nodes, vehicles: [vehicle], road }, baseOpts);
  assert.equal(r.candidati.length, 3);
  assert.equal(r.diagnostica.candidatiValidati, 0);
  assert.ok(r.candidati.every(c => !c.validazione_preliminare));
  assert.equal(r.utilizzabiliPerAttivazione, false);
});
console.log(`\n✅ ${passed}/12 TEST SUPERATI — SHADOW, NESSUNA OPERAZIONE DB`);
