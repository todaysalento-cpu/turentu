/**
 * TURENTU POPBUS V2 — TEST TURNI RICORRENTI E MULTI-VEICOLO
 * Solo lettura del sorgente worker.js; nessun import del worker, DB o rete.
 * Salvare come tests/test_popbus_turni_flotta.mjs
 * Eseguire: node tests/test_popbus_turni_flotta.mjs
 *
 * NOTA: checkConflicts usa occupazioni sintetiche in memoria.
 * Non certifica la query SQL o i dati reali di disponibilita_veicolo.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { creaValidatoriFlotta } from '../services/popbus/v2/fleet-validators.js';

const workerFile = new URL('../services/popbus/v2/worker.js', import.meta.url);
const worker = readFileSync(workerFile, 'utf8');

// Eseguiamo il codice ORIGINALE delle funzioni turno/giornoEscluso/inattivo,
// isolandolo dal resto del worker che puo' accedere al DB.
const begin = worker.indexOf("const fmt = new Intl.DateTimeFormat(");
const end = worker.indexOf('async function conflittiVeicolo(', begin);
assert.ok(begin >= 0 && end > begin, 'Impossibile individuare le funzioni dei turni nel worker');
const snippet = worker.slice(begin, end);
const context = vm.createContext({ Intl, Date, Number, Math, Array, String });
vm.runInContext(snippet + '\n globalThis.__turno = turno;', context, { timeout: 1000 });
const turno = context.__turno;
assert.equal(typeof turno, 'function');

const ms = iso => Date.parse(iso);
const range = (start, end) => [ms(start), ms(end)];
const test = (name, callback) => {
  try { callback(); console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, e.message); throw e; }
};
const base = {
  start: '2020-01-01T07:00:00.000Z', // 08:00 a Roma in inverno
  fine: '2020-01-01T19:00:00.000Z',  // 20:00 a Roma in inverno
  giorni_esclusi: [], inattivita: []
};
test('Turno ricorrente: data contenitore 2020, missione 2026', () =>
  assert.equal(turno(base, ...range('2026-10-19T08:00:00Z','2026-10-19T17:00:00Z')), true));
test('Missione fuori turno rifiutata', () =>
  assert.equal(turno(base, ...range('2026-10-19T05:00:00Z','2026-10-19T17:00:00Z')), false));
test('Giorno escluso lunedi rifiutato', () =>
  assert.equal(turno({ ...base, giorni_esclusi:['lunedi'] },
    ...range('2026-10-19T08:00:00Z','2026-10-19T17:00:00Z')), false));
test('Inattivita sovrapposta rifiutata', () =>
  assert.equal(turno({ ...base, inattivita:[{
    start:'2026-10-19T12:00:00Z', fine:'2026-10-19T14:00:00Z'
  }]}, ...range('2026-10-19T08:00:00Z','2026-10-19T17:00:00Z')), false));
test('Ora legale: 06:00 UTC equivale a 08:00 Roma, ammesso', () =>
  assert.equal(turno(base, ...range('2026-10-19T06:00:00Z','2026-10-19T17:00:00Z')), true));
test('Ora legale: oltre le 20:00 Roma, rifiutato', () =>
  assert.equal(turno(base, ...range('2026-10-19T08:00:00Z','2026-10-19T19:00:00Z')), false));

// Simuliamo il database conflitti: la chiave e' SEMPRE vehicle.id,
// NON driver_id (che identifica il titolare della flotta).
const occupied = new Map([
  [353, [{ start:ms('2026-10-19T08:00:00Z'), end:ms('2026-10-19T14:00:00Z') }]]
]);
const checkConflicts = async (v, a, b) =>
  !(occupied.get(Number(v.id)) || []).some(x => x.start < b && x.end > a);
const validators = creaValidatoriFlotta({
  checkShift: async (v, a, b) => turno(v, a, b),
  checkConflicts,
  checkPayments: async () => true,
  checkQuality: async () => true,
  checkRadius: async () => true,
  now: ms('2026-10-16T00:00:00Z')
});
const a = ms('2026-10-19T08:00:00Z');
const b = ms('2026-10-19T12:00:00Z');
const v353 = { ...base, id:353, driver_id:2 };
const v352 = { ...base, id:352, driver_id:2 };
const v354 = { ...base, id:354, driver_id:3 };
const results = [
  ['Veicolo 353 occupato: rifiutato', false, await validators.validateVehicle(v353,a,b)],
  ['Veicolo 352 stesso titolare: ammesso', true, await validators.validateVehicle(v352,a,b)],
  ['Veicolo 354 altro titolare: ammesso', true, await validators.validateVehicle(v354,a,b)],
  ['Veicolo 353 dopo fine occupazione: ammesso', true,
    await validators.validateVehicle(v353,ms('2026-10-19T14:00:00Z'),ms('2026-10-19T16:00:00Z'))]
];
for (const [name, expected, actual] of results) test(name, () => assert.equal(actual,expected));
console.log('\n=== DIAGNOSTICA ===');
console.log(JSON.stringify(validators.diagnostics(), null, 2));
console.log('\nPASS: turni ricorrenti e isolamento per veicolo nel test sintetico.');
console.log('NON CERTIFICATI: conflitti SQL reali, assegnazione transazionale, corsa unica.');
