// NCC Modello A - audit statico di resilienza, senza connessioni o mutazioni.
// Salvare come tests/test_ncc_resilienza_statico.mjs
// Eseguire dalla root: node tests/test_ncc_resilienza_statico.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve('services/corsa/corse.service.js');
const src = readFileSync(file, 'utf8');
const fn = src.slice(src.indexOf('export async function toggleCorsa('));
if (!fn.startsWith('export async function toggleCorsa(')) throw new Error('toggleCorsa non trovata');
let pass = 0, warn = 0, fail = 0;
function check(name, ok, severity='FAIL') {
  const status = ok ? 'PASS' : severity;
  if (ok) pass++; else if (severity === 'WARN') warn++; else fail++;
  console.log(`${status} | ${name}`);
}
console.log('=== TURENTU NCC - AUDIT RESILIENZA STATICO (READ ONLY) ===');
check('Transazione PostgreSQL esplicita', /client\.query\(['"]BEGIN['"]\)/.test(fn) && /client\.query\(['"]COMMIT['"]\)/.test(fn));
check('Chiusura condizionata allo stato in_corso', /\['in_corso'\]/.test(fn) && /stato\s*=\s*ANY\(\$3::varchar\[\]\)/.test(fn));
check('Quote Modello A verificate prima della cattura', fn.indexOf('somma !== Math.round') > -1 && fn.indexOf('somma !== Math.round') < fn.indexOf('stripe.paymentIntents.capture('));
check('PI Stripe succeeded riconciliato senza nuova capture', /if \(pi\.status === 'succeeded'\)/.test(fn));
check('Chiave di idempotenza Stripe presente', /idempotencyKey:\s*`capture-payment-/.test(fn));
check('Errore Modello A propagato per rollback', /if \(isModelloA\) throw err/.test(fn));
check('Cache aggiornata dopo COMMIT', fn.indexOf("client.query('COMMIT')") < fn.lastIndexOf('CacheManager.corsa.update(corsa)'));
const capture = fn.indexOf('stripe.paymentIntents.capture(');
const commit = fn.indexOf("client.query('COMMIT')");
check('Cattura Stripe esterna prima del COMMIT: finestra di incoerenza da gestire', !(capture > -1 && commit > capture), 'WARN');
check('Recovery automatico esplicito indipendente dalla richiesta end', /recovery|reconcile.*worker|outbox/i.test(fn), 'WARN');
check('Timeout applicativo o durata massima della transazione documentati', /statement_timeout|lock_timeout|AbortSignal|timeout:/i.test(fn), 'WARN');
console.log(`\nRISULTATO: ${pass} PASS, ${warn} WARN, ${fail} FAIL`);
console.log('NOTA: audit statico; NON esegue Stripe, DB o chiamate concorrenti. WARN non prova un guasto, segnala un rischio da collaudare.');
process.exitCode = fail ? 1 : 0;
