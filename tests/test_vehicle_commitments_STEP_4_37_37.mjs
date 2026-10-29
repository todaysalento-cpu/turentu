/**
 * TURENTU STEP 4.37.37 — test isolati, nessun accesso al DB o a Google Maps.
 * Copiare in tests/test_vehicle_commitments_STEP_4_37_37.mjs.
 * Eseguire dalla root: node tests/test_vehicle_commitments_STEP_4_37_37.mjs
 */
import assert from 'node:assert/strict';
import { verificaTrasferimentiVeicolo } from '../services/booking/vehicle-commitments.service.js';

const at = (minute) => new Date(Date.UTC(2026, 10, 10, 10, minute));
const commitment = (id, startMinute, endMinute, extra = {}) => ({
  fonte: 'NCC', riferimento_id: String(id), veicolo_id: 347, stato: 'prenotabile',
  inizio: at(startMinute), fine: at(endMinute),
  origine_lat: 40.1, origine_lon: 18.1,
  destinazione_lat: 40.2, destinazione_lon: 18.2,
  ...extra
});
const mission = {
  inizio: at(30), fine: at(40),
  origine: {lat: 40.3, lon: 18.3},
  destinazione: {lat: 40.4, lon: 18.4}
};
function clientFor(rows) {
  return {query: async (sql, params) => {
    assert.match(sql, /UNION ALL/);
    assert.deepEqual(params, [347]);
    return {rows};
  }};
}
let passed = 0;
async function test(label, rows, routing, check) {
  let calls = 0;
  const result = await verificaTrasferimentiVeicolo(clientFor(rows), 347, mission, {
    movement: async (...args) => { calls++; return routing(...args); }
  });
  check(result, calls);
  console.log(`PASS ${++passed} — ${label} (routing: ${calls})`);
}

await test('missione compatibile tra due impegni',
  [commitment(1, 0, 10), commitment(2, 60, 70)],
  async () => ({seconds: 300}),
  (r, n) => {assert.equal(r.compatibile, true); assert.equal(n, 2); assert.equal(r.conflitti.length, 0); assert.equal(r.nonVerificabili.length, 0);});

await test('sovrapposizione temporale: nessuna chiamata routing',
  [commitment(3, 35, 45)],
  async () => ({seconds: 0}),
  (r, n) => {assert.equal(r.compatibile, false); assert.equal(n, 0); assert.equal(r.conflitti[0]?.motivo, 'SOVRAPPOSIZIONE');});

await test('routing non disponibile: fail closed',
  [commitment(4, 0, 10)],
  async () => {const e = new Error('Routing assente'); e.code = 'VEHICLE_TRANSFER_UNVERIFIED'; throw e;},
  (r, n) => {assert.equal(r.compatibile, false); assert.equal(n, 1); assert.equal(r.nonVerificabili[0]?.motivo, 'VEHICLE_TRANSFER_UNVERIFIED');});

await test('sequenza preesistente sovrapposta: fail closed',
  [commitment(5, 0, 20), commitment(6, 15, 25)],
  async () => ({seconds: 0}),
  (r, n) => {assert.equal(r.compatibile, false); assert.equal(n, 0); assert.ok(r.nonVerificabili.some(x => x.motivo === 'SEQUENZA_ESISTENTE_SOVRAPPOSTA'));});

await test('trasferimento impossibile: fail closed',
  [commitment(7, 0, 10)],
  async () => ({seconds: 1201}),
  (r, n) => {assert.equal(r.compatibile, false); assert.equal(n, 1); assert.equal(r.conflitti[0]?.motivo, 'TRASFERIMENTO_IMPOSSIBILE');});

await test('coordinate mancanti: fail closed',
  [commitment(8, 0, 10, {destinazione_lat: null})],
  async () => ({seconds: 0}),
  (r, n) => {assert.equal(r.compatibile, false); assert.equal(n, 0); assert.equal(r.nonVerificabili[0]?.motivo, 'COORDINATE_MANCANTI');});

await test('POPBUS non concatenabile: fail closed',
  [commitment(9, 0, 10, {fonte: 'POPBUS', origine_lat: null, destinazione_lat: null})],
  async () => ({seconds: 0}),
  (r, n) => {assert.equal(r.compatibile, false); assert.equal(n, 0); assert.equal(r.nonVerificabili[0]?.motivo, 'POPBUS_ESTREMI_BUSY_NON_VERIFICATI');});

console.log(`\nRISULTATO: ${passed}/7 test superati`);
