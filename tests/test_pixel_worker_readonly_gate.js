import fs from 'node:fs';
import assert from 'node:assert/strict';
const file = new URL('../services/popbus/v2/worker.js', import.meta.url);
const s = fs.readFileSync(file, 'utf8');
const checks = [
  ['flag diagnostico', /POPBUS_PIXEL_FEASIBILITY_READONLY\s*=/.test(s)],
  ['reader PIXEL operativo nel ramo diagnostico', /async function diagnosticaFattibilitaPixelReadOnly[\s\S]*?leggiFormazioniPixelWorker\(/.test(s)],
  ['bridge PIXEL collegato', /preparaInputFattibilitaPixel\(formazioni, requests, nodes\)/.test(s)],
  ['transazione read only', /BEGIN READ ONLY/.test(s)],
  ['rollback diagnostico', /if \(tx\) await client\.query\('ROLLBACK'\)/.test(s)],
  ['economia con ritorno', /kmRitornoBase: returnTrip\.metres \/ 1000/.test(s)],
  ['scelta POPBUS', /const chosen = scegliAttivazioni\(feasible\)/.test(s)],
  ['gate prima di legacy', s.indexOf('if (POPBUS_PIXEL_FEASIBILITY_READONLY) {', s.indexOf('export async function processaProposteDinamicheV2')) < s.indexOf('const ciclo = ++numeroCiclo')],
  ['cutover ancora fail closed', /POPBUS_PIXEL_FIRST_NON_ABILITATO/.test(s)],
  ['nessun COMMIT nel ramo diagnostico', !s.slice(s.indexOf('async function diagnosticaFattibilitaPixelReadOnly'),s.indexOf('let cicliAttivi = 0')).includes("client.query('COMMIT')")]
];
let passed=0;
for(const [label,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${label}`);if(ok)passed++;}
console.log(`RISULTATO: ${passed}/${checks.length} - TEST STATICO, NON END-TO-END`);
assert.equal(passed,checks.length);
