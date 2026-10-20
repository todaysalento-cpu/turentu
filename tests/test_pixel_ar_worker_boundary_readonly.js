// Turentu POPBUS - audit statico READ ONLY del confine A/R nel worker reale.
// Nessun import del worker, nessuna connessione DB, nessuna scrittura.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(here, '../services/popbus/v2/worker.js'),
  path.resolve(here, '../services/popbus/v2/matching.worker.js'),
  path.resolve(here, '../services/popbus/v2/popbus.worker.js'),
  path.resolve(here, '../worker.js'),
];
const workerPath = process.argv[2] ? path.resolve(process.argv[2]) : candidates.find(fs.existsSync);
if (!workerPath || !fs.existsSync(workerPath)) {
  console.error('ERRORE: worker non trovato. Passare il percorso: node tests\\test_pixel_ar_worker_boundary_readonly.js services\\popbus\\v2\\worker.js');
  process.exitCode = 2;
} else {
  const source = fs.readFileSync(workerPath, 'utf8');
  const checks = [
    ['modalita PIXEL-first fail-closed', /if\s*\(POPBUS_PIXEL_FIRST\)\s*\{\s*throw new Error\('POPBUS_PIXEL_FIRST_NON_ABILITATO/],
    ['lettura PIXEL con transazione READ ONLY', /async function diagnosticaFattibilitaPixelReadOnly\(\)[\s\S]*?BEGIN READ ONLY/],
    ['generazione catene PIXEL presente', /async function eseguiCicliPixelShadow\([\s\S]*?function\* catene\(/],
    ['valutazione economica del ciclo tramite adapter', /const esito = await diagnosticaCicloPixelPopbus\(/],
    ['composizione corsa globale presente', /corsaGlobale = componiCicloInCorsa\(/],
    ['ottimizzazione flotta presente', /const scelta = ottimizzaFlotta\(proposte/],
    ['controllo duplicati nella catena', /m\.requestIds\.some\(id => used\.has\(Number\(id\)\)\)/],
    ['validazione preliminare limitata allo snapshot', /validateCandidate:\s*async\s*\(result\)\s*=>\s*result\.richieste\.every\(id => byRequest\.has\(Number\(id\)\)\)/],
    ['attivazione legacy ancora monomissione', /L'attivazione corrente rimane mono-missione/],
    ['rivalidazione finale con FOR UPDATE', /FROM richieste_pop_bus\s+WHERE id=ANY\(\$1::int\[\]\)\s+ORDER BY id\s+FOR UPDATE/],
  ];
  let passed = 0;
  for (const [label, re] of checks) {
    const ok = re.test(source);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
    if (ok) passed++;
  }
  // Segnalazioni architetturali, NON test di comportamento runtime.
  const hasArPolicy = /(?:verificaAtomicitaAR|validaVincoliAR|gateRichiesteAR|verificaGruppiVincolati)/.test(source);
  console.log(`${hasArPolicy ? 'REVIEW' : 'GAP'} gate A/R esplicito nel worker (ricerca di nomi convenzionali, non prova esaustiva)`);
  console.log('GAP NON CERTIFICATO: selezione congiunta cross-veicolo, ricomputo margini dopo esclusione A/R, commit atomico cross-missione');
  console.log('PIXEL_AR_WORKER_BOUNDARY_READONLY_JSON:' + JSON.stringify({
    passed: passed === checks.length, checksPassed: passed, checksTotal: checks.length,
    dbWrites: 0, workerModified: false, arGateNameDetected: hasArPolicy,
    audit: 'STATICO: non certifica comportamento runtime o assenza di gate con altri nomi',
  }));
  if (passed !== checks.length) process.exitCode = 1;
}
