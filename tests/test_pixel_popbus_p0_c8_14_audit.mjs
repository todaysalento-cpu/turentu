// TURENTU P0-C8.14 — Audit statico del cutover multimissione
// SOLO LETTURA: nessuna connessione DB, nessuna scrittura, nessuna chiamata Stripe.
// Copiare in tests/test_pixel_popbus_p0_c8_14_audit.mjs ed eseguire dalla root.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const files = {
  worker: 'services/popbus/v2/worker.js',
  assembler: 'services/popbus/v2/popbus-single-corsa-assembler.js',
  adapter: 'services/popbus/v2/popbus-p0-c8-adapter.js',
  staging: 'services/popbus/v2/pixel-first-transaction-STAGING.js',
  persistence: 'services/popbus/v2/popbus-cycle-persistence.js',
  acceptance: 'services/popbus/acceptance.js',
};
const read = rel => {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
};
const sources = Object.fromEntries(Object.entries(files).map(([k,v])=>[k,read(v)]));
const results = [];
function check(label, status, detail) { results.push({label,status,detail}); }
function has(k, re) { return sources[k] != null && re.test(sources[k]); }
for (const [k, rel] of Object.entries(files)) {
  check(`FILE ${k}`, sources[k] ? 'OK' : 'MISSING', rel);
}
check('Assembler importato nel worker', has('worker', /import\s*\{[^}]*componiCicloInCorsa[^}]*\}/s) ? 'OK':'MISSING', 'Il worker conosce l’assembler');
check('Assembler usato nel ramo shadow', has('worker', /async function eseguiCicliPixelShadow[\s\S]*?componiCicloInCorsa\s*\(/) ? 'OK':'MISSING', 'Non implica persistenza');
check('Adapter disponibile', has('adapter', /export\s+function\s+preparaCicloPixelPerPersistenza\s*\(/) ? 'OK':'MISSING', 'Contratto adapter P0-C8');
check('Adapter richiamato dal worker', has('worker', /\bpreparaCicloPixelPerPersistenza\s*\(/) ? 'WIRED':'NOT_WIRED', 'Ricerca chiamata diretta; non prova assenza di chiamate indirette');
check('STAGING esplicitamente mono-missione', has('staging', /missioni:\s*\[\s*\{/) ? 'MONO':'UNKNOWN', 'Verificare prima del cutover');
check('STAGING protetto ROLLBACK_ONLY', has('staging', /POPBUS_PIXEL_TX_STAGING[\s\S]{0,120}ROLLBACK_ONLY/) ? 'OK':'MISSING', 'Non sostituisce il rollback del chiamante');
check('Persistenza accetta piano globale', has('persistence', /pianoGlobale\s*=\s*null/) ? 'OK':'MISSING', 'Contratto per indici globali');
check('Worker registra singola missione', has('worker', /registraMissioniAttivazione\(client,\s*\{[\s\S]{0,120}missioni:\s*\[\s*\{/) ? 'MONO':'UNKNOWN', 'Analizzare la specifica call site');
check('Acceptance multi-preflight', has('acceptance', /verificaAccettazionePixelMulti/) ? 'OK':'MISSING', 'Non prova test E2E');
check('Acceptance multi flag', has('acceptance', /POPBUS_MULTIMISSION_ACCEPTANCE_TEST/) ? 'OK':'MISSING', 'Gate di collaudo');
check('STAGING rivalida economia', has('staging', /valutaEconomiaCiclo\s*\(/) ? 'PRESENT':'NOT_PRESENT', 'Non confondere controllo flag economia con rivalidazione');
check('STAGING rivalida turno', has('staging', /verificaTurnoVeicolo\s*\(/) ? 'PRESENT':'NOT_PRESENT', 'Non confondere controlli generici con turni ricorrenti');
console.log('\n=== TURENTU P0-C8.14 / AUDIT STATICO / READ-ONLY ===');
for (const r of results) console.log(`${r.status.padEnd(12)} ${r.label} — ${r.detail}`);
console.log('\nRISULTATO: diagnostica soltanto; NON ha eseguito un test E2E né una transazione.');
console.log('PROSSIMO GATE: preparare un fixture PIXEL economicamente valido e transazione con ROLLBACK garantito.');
if (results.some(r=>r.status==='MISSING')) process.exitCode=2;
