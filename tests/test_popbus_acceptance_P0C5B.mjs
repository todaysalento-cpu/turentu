// TURENTU POPBUS P0-C5B - audit + esecuzione reale del blocco disponibilita' con SQL mock.
// Non esegue l'intera acceptance; NON verifica transazioni PostgreSQL o concorrenza.
// Nessun accesso a DB/Stripe; nessuna modifica ai file applicativi.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const file = 'services/popbus/v2/acceptance.js';
const moduleFile = 'services/popbus/v2/popbus-vehicle-availability.js';
const source = fs.readFileSync(file, 'utf8');
const { verificaTurnoVeicolo } = await import(pathToFileURL(process.cwd() + '/' + moduleFile).href);
let pass = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch(e) { console.error('FAIL', name, e.message); process.exitCode = 1; }
}
await test('Import modulo condiviso', () => assert.match(source, /import\s*\{\s*verificaTurnoVeicolo\s*\}\s*from\s*['"]\.\/popbus-vehicle-availability\.js['"]/));
await test('Query disponibilita_veicolo con FOR UPDATE', () => {
  assert.match(source, /FROM\s+disponibilita_veicolo\s+dv/i);
  assert.match(source, /FOR\s+UPDATE\s+OF\s+dv/i);
});
await test('Controllo prima di INSERT corse', () => {
  assert.ok(source.indexOf('const { rows: disponibilitaCorrenti }') < source.indexOf('INSERT INTO corse'));
});
await test('Flag sperimentale preservato', () => assert.match(source, /POPBUS_MULTIMISSION_ACCEPTANCE_TEST/));
await test('Nessuna gestione diretta transazioni', () => assert.doesNotMatch(source, /client\.query\s*\(\s*['"`]\s*(BEGIN|COMMIT|ROLLBACK)\b/i));

// Si esegue ESATTAMENTE il blocco applicativo P0-C5B, non una sua riscrittura.
const start = source.indexOf('  const { rows: disponibilitaCorrenti }');
const end = source.indexOf('  // =====================================================\n  // 4. CONTROLLO CONFLITTI', start);
assert.ok(start > 0 && end > start, 'Blocco P0-C5B non trovato');
const block = source.slice(start, end);
const run = new Function('client','a','busyStart','busyEnd','verificaTurnoVeicolo',
  `return (async () => { ${block} return true; })();`);
const a = { veicolo_id: 353 };
const busyStart = new Date('2026-10-19T08:00:00+02:00');
const busyEnd = new Date('2026-10-19T12:00:00+02:00');
const good = {start:'2026-10-19T06:00:00+02:00', fine:'2026-10-19T18:00:00+02:00', giorni_esclusi:[], inattivita:[]};
function client(rows) {return {query: async (sql,params) => {
  assert.match(sql,/FROM\s+disponibilita_veicolo/i);
  assert.match(sql,/FOR UPDATE/i);
  assert.deepEqual(params,[353]);
  return {rows};
}};}
async function execute(rows) {return run(client(rows),a,busyStart,busyEnd,verificaTurnoVeicolo);}
await test('Turno valido consente prosecuzione', async () => assert.equal(await execute([good]), true));
await test('Nessuna disponibilita blocca', async () => assert.rejects(execute([]),/Disponibilita/i));
await test('Turno insufficiente blocca', async () => assert.rejects(execute([{...good,fine:'2026-10-19T10:00:00+02:00'}]),/Disponibilita/i));
await test('Giorno escluso blocca', async () => assert.rejects(execute([{...good,giorni_esclusi:['lunedi']}]),/Disponibilita/i));
await test('Inattivita sovrapposta blocca', async () => assert.rejects(execute([{...good,inattivita:[{start:'2026-10-19T09:00:00+02:00',fine:'2026-10-19T09:30:00+02:00'}]}]),/Disponibilita/i));
await test('Una configurazione valida fra due consente', async () => assert.equal(await execute([{...good,fine:'2026-10-19T10:00:00+02:00'},good]),true));
console.log(`ESITO: ${pass} PASS, ${process.exitCode ? 'FAIL presenti' : '0 FAIL'}. SQL MOCK; nessun DB/Stripe.`);
