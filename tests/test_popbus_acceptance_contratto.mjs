/**
 * TURENTU POPBUS — quinto collaudo: contratto acceptance.js
 * DIAGNOSTICA STATICA + esecuzione ISOLATA della sola guardia multi-missione.
 * Nessun import di acceptance.js, nessuna connessione DB, nessuna chiamata Stripe.
 *
 * Salva in: tests/test_popbus_acceptance_contratto.mjs
 * Esegui: node tests/test_popbus_acceptance_contratto.mjs
 *
 * IMPORTANTE: PASS indica che il test ha rilevato il comportamento attuale;
 * NON indica che l'accettazione multi-missione sia già supportata.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../services/popbus/v2/acceptance.js', import.meta.url), 'utf8');
const results = [];
function check(name, fn) {
  try { fn(); results.push({name, ok:true}); console.log('PASS',name); }
  catch (e) { results.push({name,ok:false,error:e.message}); console.error('FAIL',name,'—',e.message); }
}
const contains = (re, name) => check(name, () => assert.match(source,re));
const missing = (re, name) => check(name, () => assert.doesNotMatch(source,re));

console.log('=== TURENTU POPBUS / AUDIT ACCEPTANCE (NESSUNA SCRITTURA) ===');
contains(/export\s+async\s+function\s+accettaAttivazione\s*\(/, 'Funzione accettaAttivazione presente');
contains(/pg_advisory_xact_lock\s*\(\s*734021\s*,\s*1\s*\)/, 'Advisory lock transazionale globale presente');
contains(/FOR\s+UPDATE\s+OF\s+o\s*,\s*a/i, 'Offerta e attivazione bloccate');
contains(/FROM\s+veicolo[\s\S]*?driver_id\s*=\s*\$2[\s\S]*?FOR\s+UPDATE/i, 'Proprietà veicolo verificata e riga bloccata');
contains(/other\.veicolo_id\s*=\s*\$2/, 'Conflitti attivazioni filtrati per veicolo');
contains(/other\.stato\s*=\s*'confermata'/, 'Attuale filtro attivazioni: solo confermata');
contains(/c\.arrivo_datetime\s+IS\s+NULL/, 'Attuale fallback arrivo corsa NULL');
contains(/plan\.evaluation\.departure/, 'Indici temporali legati a una evaluation');
contains(/for\s*\(const\s+l\s+of\s+plan\.legs\)/, 'Geometria legata a plan.legs unico');
contains(/plan\.coordinates\[s\]/, 'Prenotazioni legate a indici globali del piano');
contains(/INSERT\s+INTO\s+corse\s*\(/i, 'Inserimento singola corsa nel ramo attuale');
contains(/INSERT\s+INTO\s+prenotazioni\s*\(/i, 'Inserimento prenotazioni nel ramo attuale');
contains(/INSERT\s+INTO\s+pagamenti\s*\(/i, 'Inserimento pagamenti nel ramo attuale');
contains(/UPDATE\s+richieste_pop_bus/i, 'Conversione richieste nel ramo attuale');

// Esegue soltanto la guardia copiata DAL FILE EFFETTIVO, non l'intera funzione.
const start = source.indexOf('if (Array.isArray(plan?.missioni) && plan.missioni.length > 1)');
const end = source.indexOf('\n\n  if (', start + 1);
check('Guardia multi-missione individuata nel sorgente', () => {
  assert.ok(start >= 0 && end > start, 'Guardia non riconosciuta: aggiornare il test');
});
if (start >= 0 && end > start) {
  const guard = source.slice(start, end);
  function runGuard(plan) {
    const ctx = vm.createContext({plan,Error,Array});
    vm.runInContext(guard, ctx, {timeout:1000});
  }
  check('Una missione supera la guardia', () => assert.doesNotThrow(() => runGuard({missioni:[{}]})));
  check('Tre missioni sono BLOCCATE dalla guardia attuale', () => assert.throws(
    () => runGuard({missioni:[{},{},{}]}),
    /Accettazione ciclo multi-missione non ancora abilitata/
  ));
}

console.log('\n=== RISCHI DA RISOLVERE PRIMA DELLA PRODUZIONE ===');
console.log('1. Multi-missione esplicitamente non abilitata.');
console.log('2. Serve un piano unificato con fermate/offset/indici e orari coerenti.');
console.log('3. Il controllo delle altre attivazioni considera solo confermata.');
console.log('4. I conflitti corse non usano esplicitamente il busyEnd del ciclo collegato.');
console.log('5. Il router deve garantire BEGIN/COMMIT/ROLLBACK; qui non viene verificato.');
console.log('6. Non verificati: transazioni concorrenti, Stripe, schema di persistenza multi-missione.');
const failures=results.filter(r=>!r.ok);
console.log(`\nEsito audit: ${results.length-failures.length}/${results.length} controlli superati.`);
console.log('Nessuna scrittura. NON certifica l’accettazione multi-missione.');
if(failures.length) process.exitCode=1;
