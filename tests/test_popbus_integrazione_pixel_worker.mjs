// TURENTU POPBUS — TEST 8: contratto PIXEL -> WORKER -> ASSEMBLER
// Solo lettura: nessuna connessione DB, nessun Stripe, nessuna scrittura.
// Salvare come tests/test_popbus_integrazione_pixel_worker.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = path.join(root, 'services/pixel/pixel-popbus-cycle-adapter.js');
const workerPath = path.join(root, 'services/popbus/v2/worker.js');
const assemblerPath = path.join(root, 'services/popbus/v2/popbus-single-corsa-assembler.js');
const read = p => { if (!fs.existsSync(p)) throw Error(`File mancante: ${p}`); return fs.readFileSync(p,'utf8'); };
const adapter = read(adapterPath), worker = read(workerPath), assembler = read(assemblerPath);
let pass = 0, findings = 0, failures = 0;
function ok(name, test) { try { assert.ok(test); console.log('PASS',name); pass++; } catch(e) { console.log('FAIL',name, e.message); failures++; } }
function gap(name, condition, explanation) {
  if (condition) { console.log('GAP CONFERMATO',name,'—',explanation); findings++; }
  else { console.log('NON CONFERMATO',name,'— verificare se il codice e stato aggiornato'); }
}
function bodyBetween(src, start, end) {
  const a = src.indexOf(start); if(a < 0) return '';
  const b = src.indexOf(end, a+start.length);
  return src.slice(a, b < 0 ? undefined : b);
}
console.log('=== TURENTU POPBUS / TEST 8 CONTRATTO PIXEL-WORKER-ASSEMBLER ===');
ok('I tre moduli sono presenti', adapter.length>0 && worker.length>0 && assembler.length>0);
ok('Adapter esporta diagnosticaCicloPixelPopbus', /export\s+async\s+function\s+diagnosticaCicloPixelPopbus\s*\(/.test(adapter));
ok('Worker importa assembler', /import\s*\{\s*componiCicloInCorsa\s*\}\s*from\s*['"]\.\/popbus-single-corsa-assembler\.js['"]/.test(worker));
ok('Worker invoca assembler', /corsaGlobale\s*=\s*componiCicloInCorsa\s*\(/.test(worker));
ok('Assembler mantiene attivabile false', /attivabile\s*:\s*false/.test(assembler));
ok('Assembler supporta postiTotali', /postiTotali\s*=\s*null/.test(assembler));
ok('Assembler supporta calcolo occupazione', /export\s+function\s+calcolaOccupazioneCiclo\s*\(/.test(assembler));

const resultStart = adapter.indexOf('const result={ok:true,attivabile:false');
const resultEnd = adapter.indexOf('if (!economia.economicamenteAttivabile)',resultStart);
const adapterResult = resultStart >= 0 ? adapter.slice(resultStart,resultEnd < 0 ? undefined : resultEnd) : '';
const callStart = worker.indexOf('corsaGlobale = componiCicloInCorsa({');
const callEnd = worker.indexOf('});',callStart);
const workerCall = callStart >= 0 ? worker.slice(callStart,callEnd < 0 ? undefined : callEnd) : '';
console.log('\n--- INCOMPATIBILITA CONTRATTUALI ---');
gap('Missioni senza legs', /missioni\s*:\s*evaluations\.map/.test(adapterResult) && !/legs\s*:/.test(adapterResult), 'Assembler richiede m.legs per ogni missione');
gap('Trasferimenti senza polyline/leg', /trasferimenti\s*:\s*links\.map/.test(adapterResult) && !/polyline\s*:|leg\s*:/.test(adapterResult), 'Assembler richiede geometria del trasferimento se non coincidente');
gap('Missioni senza posti_richiesti espliciti', /requests\s*:\s*e\.evaluation\.requests/.test(adapterResult) && !/posti_richiesti\s*:/.test(adapterResult), 'Verificare se evaluation.requests include davvero i posti; non presumere che li contenga');
gap('Worker non passa postiTotali', callStart >= 0 && !/postiTotali\s*:/.test(workerCall), 'La capienza globale non puo essere marcata verificata');
gap('Adapter non propaga geometria di trasferimento', /links\.push\(\{transfer,waitMs\}\)/.test(adapter) && !/polyline\s*:|leg\s*:/.test(adapterResult), 'Occorre preservare il routing reale');

console.log('\n--- CONTROLLO DINAMICO ASSEMBLER (NESSUNA SCRITTURA) ---');
try {
  const { componiCicloInCorsa } = await import(pathToFileURL(assemblerPath).href);
  const start = Date.UTC(2027,3,1,8,0,0);
  const nodes = [{id:7,lat:40.35,lon:18.17},{id:5,lat:40.12,lon:18.29}];
  const minimal = {
    missioni:[{nodes:[7,5],departure:start,arrival:start+1800000,
      requests:[{id:101,start:0,end:1,posti_richiesti:2}]}],
    trasferimenti:[],nodi:nodes,veicoloId:353,
    busyStart:new Date(start-600000).toISOString(),busyEnd:new Date(start+2400000).toISOString(),
    postiTotali:4,approach:{metres:1000,seconds:600},returnTrip:{metres:1000,seconds:600}
  };
  let rejected=false;
  try { componiCicloInCorsa(minimal); } catch(e) { rejected=true; console.log('RIFIUTO ATTESO',e.message); }
  ok('Assembler rifiuta missione senza legs', rejected);
  const leg = {metres:20000,seconds:1800,polyline:'_p~iF~ps|U_ulLnnqC'};
  const plan = componiCicloInCorsa({...minimal,missioni:[{...minimal.missioni[0],legs:[leg]}]});
  ok('Assembler accetta contratto completo sintetico', plan.evaluation.peak===2 && plan.validazioneCapienza?.verificata===true && plan.attivabile===false);
} catch(e) { console.log('FAIL Importazione/esecuzione assembler:',e.stack||e.message); failures++; }

console.log('\nRIEPILOGO',JSON.stringify({pass,failures,gapContrattuali:findings,modalita:'SOLA_LETTURA'},null,2));
console.log('NOTA: GAP CONFERMATO non e un fallimento del test: e una incompatibilita reale da risolvere.');
console.log('Questo test non prova ancora l end-to-end reale con PIXEL, routing e database.');
if(failures) process.exitCode=1;
