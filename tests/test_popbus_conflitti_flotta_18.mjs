// TURENTU POPBUS - TEST 18 - CONFLITTI OPERATIVI E FLOTTA
// Sola lettura. Nessuna connessione DB, Stripe o scrittura.
// Salvare come tests/test_popbus_conflitti_flotta_18.mjs
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const paths = {
  worker: 'services/popbus/v2/worker.js',
  acceptance: 'services/popbus/v2/acceptance.js',
  optimizer: 'services/popbus/v2/fleet-optimizer.js',
};
const source = {};
let pass = 0, fail = 0, gap = 0;
const findings = [];
function record(kind, label, detail = '') {
  if (kind === 'PASS') pass++;
  else if (kind === 'FAIL') fail++;
  else { gap++; findings.push({ label, detail }); }
  console.log(`${kind.padEnd(4)} ${label}${detail ? ' — ' + detail : ''}`);
}
function check(label, condition, detail = '') { record(condition ? 'PASS' : 'FAIL', label, condition ? '' : detail); }
function note(label, detail) { record('GAP', label, detail); }
function has(file, pattern) { return pattern.test(source[file] ?? ''); }
function overlaps(a, b) {
  return a.start < b.end && a.end > b.start;
}
function interval(start, end) {
  const a = Date.parse(start), b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) throw new Error('Intervallo non valido');
  return { start: a, end: b };
}
function conflict(candidate, existing, states = new Set(['in_attesa_autista', 'confermata'])) {
  return existing.some(x => x.veicolo_id === candidate.veicolo_id && states.has(x.stato) && overlaps(candidate, x));
}
function shiftAllows(shift, busy, weekday) {
  if (shift.excluded.includes(weekday)) return false;
  if (shift.inactivity.some(x => overlaps(x, busy))) return false;
  return busy.start >= shift.start && busy.end <= shift.end;
}
function test(label, fn) {
  try { check(label, fn() === true, 'Risultato inatteso'); }
  catch (e) { record('FAIL', label, e.message); }
}

console.log('=== TURENTU POPBUS / TEST 18 CONFLITTI E FLOTTA ===');
console.log('MODALITA: AUDIT SORGENTI + ORACOLO SINTETICO / ZERO DB / ZERO STRIPE');
for (const [key, relative] of Object.entries(paths)) {
  const full = path.join(root, relative);
  try { source[key] = fs.readFileSync(full, 'utf8'); console.log('SORGENTE:', relative); }
  catch (e) { source[key] = ''; record('FAIL', `Sorgente ${relative} leggibile`, e.message); }
}

console.log('\n--- AUDIT REALE DEI SORGENTI ---');
check('Worker contiene controllo conflittiVeicolo', has('worker', /\bconflittiVeicolo\b/));
check('Worker considera attivazioni in attesa', has('worker', /in_attesa_autista/));
check('Worker considera attivazioni confermate', has('worker', /confermata/));
check('Worker usa intervallo busyStart/busyEnd', has('worker', /busyStart/) && has('worker', /busyEnd/));
check('Worker usa confronto intervalli SQL', has('worker', /<\s*\$3::timestamptz/) && has('worker', />\s*\$2::timestamptz/));
check('Worker filtra veicolo nella query conflitti', has('worker', /veicolo_id\s*=\s*\$1/));
check('Worker considera giorni esclusi', has('worker', /giorni_esclusi/));
check('Worker considera inattivita', has('worker', /inattivita/));
check('Acceptance controlla busyStart/busyEnd', has('acceptance', /busyStart/) && has('acceptance', /busyEnd/));
check('Acceptance acquisisce lock transazionale', has('acceptance', /pg_advisory_xact_lock/));
check('Acceptance controlla veicolo', has('acceptance', /veicolo_id/));
check('Acceptance mantiene blocco multi-missione', has('acceptance', /multi.missione non ancora abilitata/i));
check('Ottimizzatore considera veicoli', has('optimizer', /veicolo/i));
check('Ottimizzatore considera richieste', has('optimizer', /richiest/i));

console.log('\n--- CASI SINTETICI DI CONFLITTO (ORACOLO INDIPENDENTE) ---');
const A = interval('2027-04-01T08:00:00Z', '2027-04-01T12:00:00Z');
const B = interval('2027-04-01T10:00:00Z', '2027-04-01T14:00:00Z');
const C = interval('2027-04-01T12:00:00Z', '2027-04-01T15:00:00Z');
const D = interval('2027-04-01T06:00:00Z', '2027-04-01T08:00:00Z');
const inside = interval('2027-04-01T09:00:00Z', '2027-04-01T11:00:00Z');
const whole = interval('2027-04-01T07:00:00Z', '2027-04-01T16:00:00Z');
test('Sovrapposizione parziale rilevata', () => overlaps(A, B));
test('Intervalli adiacenti non confliggono (fine = inizio)', () => !overlaps(A, C));
test('Intervalli adiacenti prima non confliggono', () => !overlaps(A, D));
test('Intervallo contenuto confligge', () => overlaps(A, inside));
test('Intervallo contenitore confligge', () => overlaps(A, whole));
test('Intervallo identico confligge', () => overlaps(A, A));
test('Intervallo invertito rifiutato', () => { try { interval('2027-04-01T12:00:00Z', '2027-04-01T08:00:00Z'); return false; } catch { return true; } });
test('Data non valida rifiutata', () => { try { interval('non-data', '2027-04-01T08:00:00Z'); return false; } catch { return true; } });
const candidate = { ...A, veicolo_id: 353 };
test('Stesso veicolo e offerta in attesa: conflitto', () => conflict(candidate, [{ ...B, veicolo_id: 353, stato: 'in_attesa_autista' }]));
test('Stesso veicolo e attivazione confermata: conflitto', () => conflict(candidate, [{ ...B, veicolo_id: 353, stato: 'confermata' }]));
test('Veicolo diverso stesso titolare: nessun conflitto', () => !conflict(candidate, [{ ...B, veicolo_id: 354, driver_id: 2, stato: 'confermata' }]));
test('Offerta annullata non riserva il veicolo', () => !conflict(candidate, [{ ...B, veicolo_id: 353, stato: 'annullata' }]));
test('Intervalli disgiunti stesso veicolo: consentiti', () => !conflict(candidate, [{ ...C, veicolo_id: 353, stato: 'confermata' }]));
test('Conflitto su avvicinamento incluso in busy', () => conflict(candidate, [{ ...interval('2027-04-01T07:30:00Z', '2027-04-01T08:30:00Z'), veicolo_id: 353, stato: 'confermata' }]));
test('Conflitto su ritorno incluso in busy', () => conflict(candidate, [{ ...interval('2027-04-01T11:30:00Z', '2027-04-01T12:30:00Z'), veicolo_id: 353, stato: 'confermata' }]));
test('Offerta in attesa di altro veicolo non confligge', () => !conflict(candidate, [{ ...B, veicolo_id: 354, stato: 'in_attesa_autista' }]));
const shift = { start: Date.parse('2027-04-01T07:00:00Z'), end: Date.parse('2027-04-01T14:00:00Z'), excluded: [0], inactivity: [] };
test('Turno include tutto busy: consentito', () => shiftAllows(shift, A, 4));
test('Busy supera fine turno: rifiutato', () => !shiftAllows(shift, C, 4));
test('Giorno escluso: rifiutato', () => !shiftAllows(shift, A, 0));
test('Inattivita sovrapposta: rifiutato', () => !shiftAllows({ ...shift, inactivity: [inside] }, A, 4));
test('Inattivita adiacente: consentito', () => shiftAllows({ ...shift, inactivity: [C] }, A, 4));

console.log('\n--- GAP DI INTEGRAZIONE DA NON CONFONDERE CON FAIL ---');
if (has('acceptance', /other\.stato\s*=\s*'confermata'/))
  note('Divergenza stati worker / acceptance', 'Worker considera in_attesa_autista e confermata; acceptance sembra considerare solo confermata. Verificare policy delle offerte concorrenti.');
else note('Coerenza stati worker / acceptance', 'Non dimostrata da audit statico; confrontare le query SQL effettive.');
note('Oracolo sintetico non esegue SQL worker', 'I casi PASS testano regole indipendenti, non invocano conflittiVeicolo sul database.');
note('Turni reali e DST Europe/Rome', 'I casi sintetici sono UTC; la logica turni/DST reale richiede integrazione o test specifici precedenti.');
note('Conflitti corse legacy', 'Verificare come sono rappresentati avvicinamento e ritorno delle corse non POPBUS.');
note('Concorrenza reale su PostgreSQL', 'Nessuna accettazione concorrente e nessun lock reale esercitato.');
note('Ciclo multi-missione end-to-end', 'La guardia di acceptance resta attiva: nessuna attivazione reale testata.');

console.log('\nRIEPILOGO', JSON.stringify({ pass, fail, gap, modalita: 'SOLA LETTURA', findings }, null, 2));
console.log(`ESITO: ${pass} PASS, ${fail} FAIL, ${gap} GAP. Nessuna scrittura.`);
if (fail) process.exitCode = 1;
