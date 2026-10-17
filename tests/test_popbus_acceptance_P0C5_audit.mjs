// TURENTU POPBUS P0-C5 — audit STATICO in sola lettura.
// Copiare in tests/test_popbus_acceptance_P0C5_audit.mjs
// Non esegue SQL, non importa acceptance, non chiama Stripe.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const candidates = [
  'services/popbus/v2/acceptance.js',
  'services/popbus/acceptance.js',
];
const workerCandidates = [
  'services/popbus/v2/worker.js',
  'services/popbus/worker.js',
  'services/popbus/matching.worker.js',
];
function locate(list, label) {
  const file = list.map(x => path.join(root, x)).find(x => fs.existsSync(x));
  if (!file) throw new Error(`${label} non trovato. Percorsi cercati: ${list.join(', ')}`);
  return file;
}
const acceptanceFile = locate(candidates, 'acceptance');
const workerFile = locate(workerCandidates, 'worker');
const acceptance = fs.readFileSync(acceptanceFile, 'utf8');
const worker = fs.readFileSync(workerFile, 'utf8');
let pass = 0, gap = 0;
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'GAP '} ${label}`);
  ok ? pass++ : gap++;
}
console.log('=== POPBUS P0-C5 / AUDIT ALLINEAMENTO ACCEPTANCE-WORKER ===');
console.log('Acceptance:', path.relative(root, acceptanceFile));
console.log('Worker:', path.relative(root, workerFile));
check('Worker ha controllo turno', /function\s+turno\s*\(/.test(worker));
check('Worker verifica inattivita', /function\s+inattivo\s*\(/.test(worker));
check('Worker verifica giorni esclusi', /function\s+giornoEscluso\s*\(/.test(worker));
check('Worker controlla direttrici virtuali', /direttrici_virtuali/.test(worker));
check('Acceptance usa busyStart e busyEnd', /busyStart/.test(acceptance) && /busyEnd/.test(acceptance));
check('Acceptance mantiene flag sperimentale', /POPBUS_MULTIMISSION_ACCEPTANCE_TEST/.test(acceptance));
check('Acceptance esclude attivazione corrente', /other\.id\s*<>\s*\$1/.test(acceptance));
check('Acceptance considera pending e confermate', /other\.stato\s+IN\s*\(\s*'in_attesa_autista'\s*,\s*'confermata'\s*\)/.test(acceptance));
check('Acceptance rilegge disponibilita_veicolo', /\b(?:FROM|JOIN)\s+(?:public\.)?disponibilita_veicolo\b/i.test(acceptance));
check('Acceptance richiama una verifica turno condivisa', /(?:verificaTurno|turnoValido|verificaDisponibilitaOperativa)\s*\(/.test(acceptance));
check('Acceptance controlla direttrici virtuali', /\b(?:FROM|JOIN)\s+(?:public\.)?direttrici_virtuali\b/i.test(acceptance));
check('Acceptance considera inattivita', /\binattivita\b/.test(acceptance));
check('Acceptance considera giorni esclusi', /\bgiorni_esclusi\b/.test(acceptance));
console.log(`ESITO AUDIT: ${pass} PASS, ${gap} GAP. GAP = controlli da verificare/integrare, non fallimenti di runtime.`);
console.log('LIMITI: ricerca testuale; non prova correttezza semantica, transazioni o concorrenza. Nessuna scrittura DB/Stripe.');
