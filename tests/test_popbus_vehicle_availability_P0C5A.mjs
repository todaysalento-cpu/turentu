// TURENTU POPBUS P0-C5A — test puro ed equivalenza con il worker locale.
// Collocare in tests/ e rinominare .mjs. NON accede a DB o Stripe.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modulo = await import(pathToFileURL(resolve(root, 'services/popbus/v2/popbus-vehicle-availability.js')).href);
const workerSource = readFileSync(resolve(root, 'services/popbus/v2/worker.js'), 'utf8');
const start = workerSource.indexOf("const fmt = new Intl.DateTimeFormat");
const end = workerSource.indexOf('// Unica fonte per la verifica iniziale', start);
assert.ok(start >= 0 && end > start, 'Impossibile estrarre la funzione turno dal worker: verificare versione');
const workerBlock = workerSource.slice(start, end);
const ctx = vm.createContext({ Intl, Date, Number, String, Array, Math });
const { turno: workerTurno, inattivo: workerInattivo, giornoEscluso: workerGiornoEscluso } =
  vm.runInContext(workerBlock + '\n({ turno, inattivo, giornoEscluso })', ctx);
let ok = 0;
function check(nome, fn) { try { fn(); ok++; console.log('PASS', nome); } catch(e) { console.error('FAIL', nome, e.message); process.exitCode = 1; } }
const d = x => new Date(x).getTime();
const base = { start:'2026-01-01T08:00:00+01:00', fine:'2026-01-01T20:00:00+01:00', giorni_esclusi:[], inattivita:[] };
const cases = [
  ['Turno diurno consentito', base, d('2026-10-19T09:00:00+02:00'), d('2026-10-19T11:00:00+02:00'), true],
  ['Prima del turno', base, d('2026-10-19T07:00:00+02:00'), d('2026-10-19T09:00:00+02:00'), false],
  ['Dopo il turno', base, d('2026-10-19T19:00:00+02:00'), d('2026-10-19T21:00:00+02:00'), false],
  ['Lunedi escluso', {...base,giorni_esclusi:['lunedi']}, d('2026-10-19T09:00:00+02:00'), d('2026-10-19T11:00:00+02:00'), false],
  ['Inattivita sovrapposta', {...base,inattivita:[{start:'2026-10-19T10:00:00+02:00',fine:'2026-10-19T12:00:00+02:00'}]}, d('2026-10-19T09:00:00+02:00'), d('2026-10-19T11:00:00+02:00'), false],
  ['Inattivita non sovrapposta', {...base,inattivita:[{start:'2026-10-19T12:00:00+02:00',fine:'2026-10-19T13:00:00+02:00'}]}, d('2026-10-19T09:00:00+02:00'), d('2026-10-19T11:00:00+02:00'), true],
  ['Turno notturno', {...base,start:'2026-01-01T20:00:00+01:00',fine:'2026-01-01T06:00:00+01:00'}, d('2026-10-19T23:00:00+02:00'), d('2026-10-20T02:00:00+02:00'), true],
  ['Esclusione giorno inizio turno notturno', {...base,start:'2026-01-01T20:00:00+01:00',fine:'2026-01-01T06:00:00+01:00',giorni_esclusi:['lunedi']}, d('2026-10-19T23:00:00+02:00'), d('2026-10-20T02:00:00+02:00'), false],
  ['Intervallo nullo', base, d('2026-10-19T09:00:00+02:00'), d('2026-10-19T09:00:00+02:00'), false],
  ['Ora legale primavera', {...base,start:'2026-01-01T00:00:00+01:00',fine:'2026-01-01T05:00:00+01:00'}, d('2026-03-29T01:30:00+01:00'), d('2026-03-29T04:30:00+02:00'), true],
  ['Ora solare autunno', {...base,start:'2026-01-01T00:00:00+01:00',fine:'2026-01-01T05:00:00+01:00'}, d('2026-10-25T01:30:00+02:00'), d('2026-10-25T04:30:00+01:00'), true],
];
for (const [name, v, a, b, expected] of cases) {
  check(name, () => {
    assert.equal(modulo.verificaTurnoVeicolo(v,a,b), expected);
    assert.equal(modulo.verificaTurnoVeicolo(v,a,b), workerTurno(v,a,b), 'Divergenza dal worker');
  });
}
check('Equivalenza inattivita worker', () => {
  for (const [name,v,a,b] of cases) assert.equal(modulo.intervalloInattivo(v,a,b), workerInattivo(v,a,b),name);
});
check('Equivalenza giorni esclusi worker', () => {
  for (const giorno of [0,1,2,3,4,5,6,7,'lunedi','domenica','mar','sabato']) {
    assert.equal(modulo.giornoOperativoEscluso([giorno],d('2026-10-19T10:00:00+02:00')),workerGiornoEscluso([giorno],d('2026-10-19T10:00:00+02:00')));
  }
});
console.log(`ESITO: ${ok} PASS, ${cases.length + 2 - ok} FAIL. Test puro; nessun DB/Stripe; worker non modificato.`);
