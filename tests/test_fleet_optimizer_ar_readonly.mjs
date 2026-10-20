// TURENTU — test isolato ottimizzatore POPBUS V2, nessun database.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const target = resolve(process.argv[2] ?? 'services/popbus/v2/fleet-optimizer.ar-readonly.js');
const { ottimizzaFlotta } = await import(pathToFileURL(target).href);
const BASE = Date.parse('2026-11-01T12:00:00Z');
const c = (veicolo, richieste, inizio, fine, margine) => ({
  veicolo, richieste, partenza_base: BASE + inizio * 60000,
  ritorno_base: BASE + fine * 60000, margine_ciclo_con_attesa_euro: margine
});
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS', name); }
  catch (e) { console.error('FAIL', name, e.stack); process.exitCode = 1; }
}
const run = (items, extra={}) => ottimizzaFlotta(items, {maxNodi:100000, maxCandidati:1000, ...extra});
test('01 ordinario: seleziona margini positivi e ignora negativi', () => {
  const r=run([c(1,[1],0,10,10),c(2,[2],0,10,-5)]);
  assert.equal(r.margineTotaleEuro,10); assert.deepEqual(r.richiesteIds,[1]);
});
test('02 una richiesta non puo essere assegnata due volte', () => {
  const r=run([c(1,[1],0,10,10),c(2,[1],0,10,12)]);
  assert.equal(r.margineTotaleEuro,12); assert.equal(r.selezionati.length,1);
});
test('03 stesso veicolo: intervalli sovrapposti incompatibili', () => {
  const r=run([c(1,[1],0,20,10),c(1,[2],10,30,12)]);
  assert.equal(r.margineTotaleEuro,12);
});
test('04 stesso veicolo: cicli adiacenti compatibili', () => {
  const r=run([c(1,[1],0,10,10),c(1,[2],10,20,12)]);
  assert.equal(r.margineTotaleEuro,22);
});
test('05 veicoli diversi, stesso proprietario: indipendenti per ID veicolo', () => {
  const r=run([c(1,[1],0,20,10),c(2,[2],0,20,12)]);
  assert.equal(r.margineTotaleEuro,22);
});
test('06 A/R: tratta negativa obbligatoria, coppia globalmente positiva', () => {
  const r=run([c(1,[101],0,10,20),c(2,[201],20,30,-7)],
    {arPairs:[{andata:101,ritorno:201}]});
  assert.equal(r.margineTotaleEuro,13);
  assert.deepEqual(r.richiesteIds,[101,201]);
});
test('07 A/R: sola andata positiva non attivabile', () => {
  const r=run([c(1,[101],0,10,20)],
    {arPairs:[{andata:101,ritorno:201}]});
  assert.equal(r.margineTotaleEuro,0);
  assert.deepEqual(r.richiesteIds,[]);
});
test('08 A/R: ordinaria positiva indipendente da coppia non conveniente', () => {
  const r=run([c(1,[101],0,10,5),c(2,[201],20,30,-30),c(3,[301],0,10,8)],
    {arPairs:[{andata:101,ritorno:201}]});
  assert.equal(r.margineTotaleEuro,8);
  assert.deepEqual(r.richiesteIds,[301]);
});
test('09 A/R: partner su veicoli distinti dello stesso titolare consentiti', () => {
  const r=run([c(1,[101],0,20,8),c(2,[201],0,20,6)],
    {arPairs:[{andata:101,ritorno:201}]});
  assert.equal(r.margineTotaleEuro,14);
});
test('10 A/R: coppia non valida rifiutata', () => {
  assert.throws(()=>run([],{arPairs:[{andata:1,ritorno:1}]}),/coppia non valida/);
});
test('11 A/R: nessun troncamento silenzioso dei candidati', () => {
  assert.throws(()=>run([c(1,[1],0,10,1),c(2,[2],0,10,1)],
    {arPairs:[],maxCandidati:1}),/AR_CANDIDATI_LIMIT/);
});
test('12 A/R: limite nodi causa fail-closed', () => {
  assert.throws(()=>run([c(1,[1],0,10,10),c(2,[2],0,10,10)],
    {arPairs:[],maxNodi:1}),/AR_NODI_LIMIT/);
});
test('13 ordinario: input negativo soltanto -> soluzione vuota', () => {
  const r=run([c(1,[1],0,10,-14.62),c(2,[2],0,10,-320.82)]);
  assert.equal(r.margineTotaleEuro,0);
});
test('14 A/R: input negativo soltanto -> soluzione vuota', () => {
  const r=run([c(1,[101],0,10,-14.62),c(2,[201],20,30,-5)],
    {arPairs:[{andata:101,ritorno:201}]});
  assert.equal(r.margineTotaleEuro,0);
});
console.log(`RISULTATO: ${passed}/14 test superati`);
if (passed!==14) process.exitCode=1;
