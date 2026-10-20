// TURENTU — AUDIT STATICO ARCHITETTURA PIXEL -> POPBUS V2
// Nessuna importazione del backend, connessione DB, chiamata worker o scrittura.
// Esecuzione: node tests\test_popbus_v2_audit_architetturale.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'services/popbus/v2/worker.js',
  'services/popbus/v2/fleet-candidates.js',
  'services/popbus/v2/model.js',
  'services/pixel/pixel.persistence.service.js'
];
let issues = 0;
const read = rel => {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) { console.log(`FILE ASSENTE: ${rel}`); issues++; return null; }
  return fs.readFileSync(full, 'utf8');
};
const files = new Map(targets.map(f => [f, read(f)]));
const lines = src => src.split(/\r?\n/);
function hits(rel, label, pattern, limit=12) {
  const src = files.get(rel);
  console.log(`\n[${label}] ${rel}`);
  if (src === null) return [];
  const found = lines(src).flatMap((line, i) => pattern.test(line) ? [{line:i+1,text:line.trim().slice(0,190)}] : []);
  if (!found.length) console.log('  Nessuna corrispondenza testuale');
  for (const x of found.slice(0,limit)) console.log(`  L${x.line}: ${x.text}`);
  if (found.length>limit) console.log(`  ... altre ${found.length-limit} corrispondenze`);
  return found;
}
console.log('===================================================');
console.log('TURENTU — AUDIT STATICO PIXEL / POPBUS V2');
console.log('SOLO LETTURA FILE — NESSUNA ESECUZIONE BACKEND');
console.log('===================================================');
console.log('Root:',root);
for (const f of targets) console.log(files.get(f) === null ? 'MANCANTE' : 'PRESENTE',f);

const worker = 'services/popbus/v2/worker.js';
const fleet = 'services/popbus/v2/fleet-candidates.js';
const model = 'services/popbus/v2/model.js';
const persistence = 'services/pixel/pixel.persistence.service.js';
const pixelRead = hits(worker,'LETTURA OPPORTUNITA PIXEL',/leggiOpportunitaPixel|verificaOpportunitaPixelPersistenti|POPBUS_PIXEL_DB_SHADOW/i);
const directRead = hits(worker,'LETTURA DIRETTA DOMANDA',/richieste_pop_bus|SELECT\s+r\.\*|FROM\s+public\.richieste_pop_bus/i);
const fleetCall = hits(worker,'CHIAMATA GENERATORE FLOTTA',/generaCandidatiFlotta|POPBUS_FLEET_SHADOW|eseguiFleetShadow/i);
const grouping = hits(fleet,'RAGGRUPPAMENTO AUTONOMO PER OD E ORARIO',/start_node_id|end_node_id|dateMs\(|group|aggregate\(/i,25);
const seats = hits(fleet,'CONTROLLI CAPACITA FLOTTA',/posti_richiesti|posti_totali|seats|maxSeats/i,25);
const modelSeats = hits(model,'CONTROLLI CAPACITA SEGMENTI',/posti_richiesti|occupancy|maxPeak/i,20);
const pixelContract = hits(persistence,'CONTRATTO PERSISTENZA PIXEL',/export\s+(async\s+)?function\s+leggiOpportunitaPixel|pixel_opportunita_richieste|client\s*=\s*null/i,20);
const econ = hits(worker,'ECONOMIA / ATTIVAZIONE',/soglia|ritorno|econom|attiva|capture/i,25);

console.log('\n================= SINTESI =================');
console.log('Reader PIXEL menzionato nel worker:',pixelRead.length>0);
console.log('Lettura diretta richieste nel worker:',directRead.length>0);
console.log('Generatore flotta menzionato nel worker:',fleetCall.length>0);
console.log('Indizi raggruppamento autonomo in fleet-candidates:',grouping.length>0);
console.log('Controlli posti in fleet-candidates:',seats.length>0);
console.log('Controlli posti in model:',modelSeats.length>0);
console.log('Contratto reader PIXEL individuato:',pixelContract.length>0);
console.log('Indizi economia/attivazione nel worker:',econ.length>0);
console.log('File mancanti:',issues);
console.log('\nNOTA: i match testuali NON provano da soli il flusso operativo.');
console.log('Per certificare le violazioni, esaminare chiamanti, condizioni e percorsi di esecuzione.');
console.log('NESSUN DATO MODIFICATO.');
if (issues) process.exitCode=2;
