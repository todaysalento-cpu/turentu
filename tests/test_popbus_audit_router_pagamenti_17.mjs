/**
 * TURENTU POPBUS — TEST 17 / AUDIT ROUTER, TRANSAZIONI, PAGAMENTI
 * SOLA LETTURA: legge file JS/MJS, non importa moduli backend, non apre DB,
 * non esegue Stripe, non modifica alcun file.
 * Salva: tests/test_popbus_audit_router_pagamenti_17.mjs
 * Esegui dalla root: node tests/test_popbus_audit_router_pagamenti_17.mjs
 * Opzionale: POPBUS_ACCEPTANCE_ROUTER=percorso/route.js (se discovery non lo trova)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';

const root = process.cwd();
const acceptancePath = resolve(root, 'services/popbus/v2/acceptance.js');
const summary = { pass: 0, fail: 0, gap: 0 };
const findings = [];
const report = (status, label, detail = '') => {
  summary[status.toLowerCase()]++;
  findings.push({ status, label, ...(detail ? { detail } : {}) });
  console.log(`${status.padEnd(4)} ${label}${detail ? ' — ' + detail : ''}`);
};
const check = (label, ok, detail) => report(ok ? 'PASS' : 'FAIL', label, ok ? '' : detail);
const gap = (label, ok, detail) => report(ok ? 'PASS' : 'GAP', label, ok ? '' : detail);
const has = (source, pattern) => pattern.test(source);
const read = file => readFileSync(file, 'utf8');
const trimComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const jsFiles = [];
const skip = new Set(['node_modules', '.git', 'dist', 'build', '.expo', 'coverage', 'tests', '.next']);
function walk(dir, depth = 0) {
  if (depth > 7 || jsFiles.length > 3500) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!skip.has(e.name)) walk(resolve(dir, e.name), depth + 1);
    } else if (e.isFile() && ['.js', '.mjs', '.cjs'].includes(extname(e.name))) {
      jsFiles.push(resolve(dir, e.name));
    }
  }
}
console.log('=== TURENTU POPBUS / TEST 17 AUDIT ROUTER E PAGAMENTI ===');
console.log('MODALITA: AUDIT STATICO / ZERO DB / ZERO STRIPE / ZERO SCRITTURE');
if (!existsSync(acceptancePath)) {
  report('FAIL', 'File acceptance.js presente', 'Manca services/popbus/v2/acceptance.js: esegui dalla root del backend');
  console.log('RIEPILOGO', JSON.stringify(summary));
  process.exitCode = 1;
} else {
  const raw = read(acceptancePath);
  const src = trimComments(raw);
  walk(root);
  const candidates = [];
  for (const file of jsFiles) {
    if (file === acceptancePath) continue;
    let content;
    try { content = read(file); } catch { continue; }
    if (/accettaAttivazione/.test(content)) candidates.push({ file, content: trimComments(content) });
  }
  const envRouter = process.env.POPBUS_ACCEPTANCE_ROUTER;
  if (envRouter) {
    const file = resolve(root, envRouter);
    if (existsSync(file) && !candidates.some(c => c.file === file)) candidates.unshift({ file, content: trimComments(read(file)) });
  }
  console.log('SORGENTE ACCEPTANCE:', relative(root, acceptancePath));
  console.log('CANDIDATI CHIAMANTI:', candidates.map(c => relative(root, c.file)));
  check('Acceptance esporta accettaAttivazione', /export\s+async\s+function\s+accettaAttivazione\s*\(/.test(src), 'Firma export non riconosciuta');
  check('Lock advisory xact', /pg_advisory_xact_lock\s*\(/i.test(src), 'Lock transazionale non rilevato');
  check('Lock righe offerta e attivazione', /FOR\s+UPDATE\s+OF\s+o\s*,\s*a/i.test(src), 'Verificare SELECT FOR UPDATE');
  gap('Router/chiamante acceptance trovato', candidates.length > 0, 'Nessun file JS che referenzia accettaAttivazione: controllare nome e posizione router');
  const callerSources = candidates.map(c => c.content).join('\n');
  const begin = /\bBEGIN\b/i.test(callerSources);
  const commit = /\bCOMMIT\b/i.test(callerSources);
  const rollback = /\bROLLBACK\b/i.test(callerSources);
  gap('Chiamante contiene BEGIN', begin, 'Non rilevato nei file candidati; potrebbe trovarsi in un helper');
  gap('Chiamante contiene COMMIT', commit, 'Non rilevato nei file candidati; verificare flusso success');
  gap('Chiamante contiene ROLLBACK', rollback, 'Non rilevato nei file candidati; verificare flusso errore');
  gap('Chiamante passa client alla funzione', /accettaAttivazione\s*\(\s*(?:client|dbClient|connection|tx)\b/.test(callerSources), 'Verificare manualmente firma chiamante e ownership della transazione');
  gap('Chiamante rilascia connessione', /\b(?:client|dbClient|connection|tx)\.release\s*\(/.test(callerSources), 'Verificare finally/release o helper equivalente');
  check('Acceptance crea una sola riga corse per invocazione', (src.match(/INSERT\s+INTO\s+corse\s*\(/gi) || []).length === 1, 'Numero di INSERT corse inatteso');
  check('Acceptance crea prenotazioni', /INSERT\s+INTO\s+prenotazioni\s*\(/i.test(src), 'INSERT prenotazioni assente');
  check('Acceptance crea pagamenti', /INSERT\s+INTO\s+pagamenti\s*\(/i.test(src), 'INSERT pagamenti assente');
  check('Pagamento collega prenotazione e corsa', /INSERT\s+INTO\s+pagamenti\s*\(\s*prenotazione_id\s*,\s*corsa_id/i.test(src), 'Controllare SQL pagamenti');
  check('Acceptance associa corsa ad attivazione', /UPDATE\s+popbus_attivazioni[\s\S]*?corsa_id\s*=/i.test(src), 'UPDATE attivazione non individuato');
  gap('Controllo payment intent prima di INSERT', /paymentIntents\.retrieve\s*\(/.test(src), 'Verifica pagamento non individuata');
  gap('Rilevato stato di autorizzazione pagamenti', /autorizzazione/.test(src), 'Verificare mapping stati Stripe/wallet');
  gap('Richieste convertite collegate a corsa', /UPDATE\s+richieste_pop_bus[\s\S]*?corsa_id\s*=/i.test(src), 'Verificare update richieste');
  gap('Conflitti includono attivazioni in attesa', /other\.stato\s+IN\s*\([\s\S]*?in_attesa_autista[\s\S]*?confermata/i.test(src), 'SQL acceptance sembra limitarsi alle confermate: rischio offerte concorrenti');
  gap('Intervallo completo di corse legacy nel conflitto', /c\.(?:busyStart|busy_start)|c\.piano\s*->>\s*['"]busyStart/.test(src), 'Verificare copertura avvicinamento e ritorno delle corse già presenti');
  check('Guardia multi-missione ancora presente', /multi-missione non ancora abilitata/.test(src), 'Non abilitare il multi prima dei test dinamici');
  gap('Validazione delle missioni DB in acceptance', /popbus_attivazione_missioni/.test(src) && /popbus_missione_richieste/.test(src), 'Acceptance non verifica esplicitamente le righe missione');
  gap('Verifica transazione reale PostgreSQL', false, 'Audit statico: necessario DB di test isolato');
  gap('Verifica capture Stripe test', false, 'Audit statico: nessuna chiamata API, test Stripe separato');
  console.log('\nNOTA: i PASS sono controlli di presenza/forma del sorgente, NON dimostrano correttezza runtime.');
  console.log('RIEPILOGO', JSON.stringify({ ...summary, mode: 'AUDIT STATICO / NESSUNA SCRITTURA', callers: candidates.map(c => relative(root, c.file)), findings: findings.filter(f => f.status !== 'PASS') }, null, 2));
  console.log(`ESITO: ${summary.pass} PASS, ${summary.fail} FAIL, ${summary.gap} GAP. Nessuna scrittura.`);
  if (summary.fail) process.exitCode = 1;
}
