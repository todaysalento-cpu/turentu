// TURENTU — Test funzionale optimizer A/R. Solo file locale, nessun DB/write.
// Copiare in tests/ e lanciare: node tests\test_pixel_ar_optimizer_globale_readonly.js
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = [
  join(root, 'tests', 'fleet-optimizer.ar-readonly.js.txt'),
  join(root, 'tests', 'fleet-optimizer.ar-readonly.js'),
  join(root, 'services', 'popbus', 'v2', 'fleet-optimizer.ar-readonly.js.txt'),
  join(root, 'services', 'popbus', 'v2', 'fleet-optimizer.ar-readonly.js')
];
let source, sourcePath;
for (const path of paths) {
  try { source = readFileSync(path, 'utf8'); sourcePath = path; break; } catch (err) { if (err.code !== 'ENOENT') throw err; }
}
if (!source) throw new Error('File optimizer sperimentale non trovato. Copiare fleet-optimizer.ar-readonly.js.txt nella cartella tests.');
if (/\b(?:from\s*['"]|import\s*\()/.test(source)) throw new Error('Optimizer deve essere modulo puro senza import esterni');
const { ottimizzaFlotta } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const t0 = Date.parse('2027-04-01T08:00:00Z');
const min = m => t0 + m * 60000;
function c(name, veicolo, richieste, margin, start = 0, end = 60) {
  return { name, veicolo, richieste: [richieste], partenza_base: min(start), ritorno_base: min(end), margine_ciclo_con_attesa_euro: margin };
}
const pair = [{ andata: 101, ritorno: 201 }];
let checks = 0;
function check(label, fn) { fn(); checks++; console.log('PASS ' + label); }
function selected(result) { return result.selezionati.map(x => x.name).sort(); }
function ids(result) { return result.richiesteIds; }
check('ordinario invariato senza arPairs', () => {
  const r = ottimizzaFlotta([c('ordinaria', 1, [11], 12), c('negativa', 2, [12], -3)]);
  assert.deepEqual(selected(r), ['ordinaria']);
  assert.equal(r.margineTotaleEuro, 12);
});
check('A/R completo su due veicoli', () => {
  const r = ottimizzaFlotta([c('andata', 1, [101,11], 8), c('ritorno', 2, [201,21], 7)], {arPairs: pair});
  assert.deepEqual(selected(r), ['andata','ritorno']);
  assert.deepEqual(ids(r), [11,21,101,201]);
});
check('andata isolata non conta anche se profittevole', () => {
  const r = ottimizzaFlotta([c('andata', 1, [101,11], 100)], {arPairs: pair});
  assert.equal(r.cicliSelezionati, 0);
});
check('ritorno isolato non conta', () => {
  const r = ottimizzaFlotta([c('ritorno', 2, [201,21], 100)], {arPairs: pair});
  assert.equal(r.cicliSelezionati, 0);
});
check('ordinarie possono partire senza coppia A/R', () => {
  const r = ottimizzaFlotta([c('andataAR',1,[101,11],30),c('soloOrdinarie',1,[11],9)], {arPairs: pair});
  assert.deepEqual(selected(r), ['soloOrdinarie']);
  assert.deepEqual(ids(r), [11]);
});
check('margine negativo di una tratta compensato dal piano globale', () => {
  const r = ottimizzaFlotta([c('andata',1,[101],-10),c('ritorno',2,[201],25)], {arPairs: pair});
  assert.deepEqual(selected(r), ['andata','ritorno']);
  assert.equal(r.margineTotaleEuro,15);
});
check('piano A/R complessivamente negativo non attivato', () => {
  const r = ottimizzaFlotta([c('andata',1,[101],-30),c('ritorno',2,[201],25)], {arPairs: pair});
  assert.equal(r.cicliSelezionati,0);
});
check('stesso veicolo sovrapposto impedisce A/R', () => {
  const r = ottimizzaFlotta([c('andata',1,[101],12),c('ritorno',1,[201],12)], {arPairs: pair});
  assert.equal(r.cicliSelezionati,0);
});
check('stesso veicolo in intervalli disgiunti consente A/R', () => {
  const r = ottimizzaFlotta([c('andata',1,[101],12,0,60),c('ritorno',1,[201],12,60,120)], {arPairs: pair});
  assert.equal(r.cicliSelezionati,2);
});
check('richiesta duplicata su due candidate non assegnata due volte', () => {
  const r = ottimizzaFlotta([c('a',1,[101],12),c('b',2,[101],50),c('r',3,[201],10)], {arPairs: pair});
  assert.deepEqual(selected(r), ['b','r']);
});
check('gruppo A/R malformato rifiutato', () => {
  assert.throws(() => ottimizzaFlotta([c('a',1,[101],10)], {arPairs:[{andata:101,ritorno:101}]}));
});
check('troncamento candidati fail closed', () => {
  assert.throws(() => ottimizzaFlotta([c('a',1,[101],10),c('r',2,[201],10)], {arPairs:pair,maxCandidati:1}), /AR_CANDIDATI_LIMIT/);
});
check('limite nodi fail closed', () => {
  assert.throws(() => ottimizzaFlotta([c('a',1,[101],10),c('r',2,[201],10)], {arPairs:pair,maxNodi:1}), /AR_NODI_LIMIT/);
});
check('coppie multiple indipendenti', () => {
  const r = ottimizzaFlotta([c('a1',1,[101],10),c('r1',2,[201],10),c('a2',3,[102],8),c('r2',4,[202],8)], {arPairs:[...pair,{andata:102,ritorno:202}]});
  assert.equal(r.cicliSelezionati,4);
});
console.log('PIXEL_AR_OPTIMIZER_GLOBALE_READONLY_JSON:' + JSON.stringify({passed:true,checksPassed:checks,checksTotal:checks,dbWrites:0,workerModified:false,source:sourcePath,scope:'test sintetici optimizer puro; NON certifica registro A/R completo, ricomputo candidate, commit DB'}));
