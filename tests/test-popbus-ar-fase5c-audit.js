// TURENTU - FASE 5C: AUDIT STATICO NON INVASIVO
// Copiare in tests/test-popbus-ar-fase5c-audit.js
// Eseguire: node tests\test-popbus-ar-fase5c-audit.js
// Nessuna connessione al database, nessuna modifica ai sorgenti.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const acceptance = readFileSync('services/popbus/v2/acceptance.js', 'utf8');
const router = readFileSync('routes/popbus.routes.js', 'utf8');
const preflight = readFileSync('services/popbus/v2/popbus-ar-transaction-preflight.service.js', 'utf8');
const coordinator = readFileSync('services/popbus/v2/popbus-ar-coordinator.service.js', 'utf8');

const checks = [
  ['Lock globale acceptance', /pg_advisory_xact_lock\s*\(734021,\s*1\)/.test(acceptance)],
  ['Lock globale preflight', /pg_advisory_xact_lock\s*\(734021,\s*1\)/.test(preflight)],
  ['Guardia offerta A/R provvisoria', /arProvvisorie\.length\s*>\s*0/.test(acceptance)],
  ['Guardia richieste A/R', /requests\.some\s*\(r\s*=>\s*r\.ar_vincolata\s*===\s*true\)/.test(acceptance)],
  ['Verifica PIXEL', /verificaAccettazionePixel\s*\(/.test(acceptance)],
  ['Verifica pagamento', /verificaPagamento\s*\(client,\s*r\)/.test(acceptance)],
  ['Conversione richiesta', /UPDATE\s+richieste_pop_bus/i.test(acceptance)],
  ['Conferma attivazione', /UPDATE\s+popbus_attivazioni/i.test(acceptance)],
  ['Router COMMIT', /client\.query\s*\(\s*['"]COMMIT['"]\s*\)/.test(router)],
  ['Router ROLLBACK', /client\.query\s*\(\s*['"]ROLLBACK['"]\s*\)/.test(router)],
  ['Preflight senza DML esplicito', !/^\s*(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE\s+)/im.test(preflight)],
  ['Coordinatore senza DML esplicito', !/^\s*(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE\s+)/im.test(coordinator)],
];

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'OK' : 'FAIL'}: ${name}`);
  if (!pass) failed++;
}
console.log(`AUDIT STATICO FASE 5C: ${checks.length - failed}/${checks.length} verifiche superate.`);
console.log('NOTA: questo audit non dimostra atomicita, sicurezza concorrente o correttezza funzionale.');
assert.equal(failed, 0, 'Audit statico incompleto: controllare il codice, non rimuovere le protezioni');
