// TURENTU POPBUS V2 — AUDIT SHADOW DEL CONTRATTO TRANSAZIONALE
// Solo lettura dei sorgenti. NON importa worker.js, NON apre connessioni DB.
// Verifica strutturale: non sostituisce test con DB mock o PostgreSQL.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workerPath = resolve(process.cwd(), 'services/popbus/v2/worker.js');
const source = readFileSync(workerPath, 'utf8');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`✅ ${String(pass+fail).padStart(2,'0')} — ${name}`); }
  catch (e) { fail++; console.error(`❌ ${String(pass+fail).padStart(2,'0')} — ${name}: ${e.message}`); }
}
const must = (text, message) => assert.ok(source.includes(text), message || `Manca: ${text}`);
const section = (from, to) => {
  const a=source.indexOf(from); assert.ok(a>=0,`Sezione iniziale assente: ${from}`);
  const b=source.indexOf(to,a+from.length); assert.ok(b>a,`Sezione finale assente: ${to}`);
  return source.slice(a,b);
};
const final = section('// RIVALIDAZIONE E ATTIVAZIONE','// COMMIT');
const position = s => { const i=final.indexOf(s); assert.ok(i>=0,`Non trovato: ${s}`); return i; };
const before = (a,b) => assert.ok(position(a)<position(b),`Ordine errato: ${a} deve precedere ${b}`);

test('Transazione finale BEGIN',()=>must("await client.query('BEGIN')"));
test('Lock advisory transazionale',()=>must('pg_advisory_xact_lock(734021,1)'));
test('Richieste bloccate FOR UPDATE',()=>assert.match(final,/FROM richieste_pop_bus[\s\S]*?FOR UPDATE/));
test('Stato richiesta rivalidato',()=>must("r.stato !== 'in_attesa'"));
test('Corsa già associata esclusa',()=>must('r.corsa_id != null'));
test('Fingerprint richiesta confrontato',()=>must('fingerprint(r) !=='));
test('Qualità rivalidata sullo snapshot bloccato',()=>must('verificaQualitaRichieste(c.plan, locked)'));
test('Tariffa corrente ricaricata',()=>assert.match(final,/SELECT MIN\(euro_km\) AS euro_km FROM tariffe/));
test('Ricavi rivalidati dalle richieste bloccate',()=>must('locked.map(r => Number(r.prezzo))'));
test('Ritorno base incluso nella rivalidazione',()=>must('kmRitornoBase: Number(c.returnTrip.metres) / 1000'));
test('Margine netto e snapshot economico controllati',()=>{must('!finalEconomy.economicamenteAttivabile');must('finalEconomy.centesimi.costoCompleto !== c.economia?.centesimi.costoCompleto');});
test('Riserva attiva controllata prima del veicolo',()=>before('FROM popbus_attivazione_richieste','FROM veicolo'));
test('Veicolo bloccato e capienza rivalidata',()=>assert.match(final,/FROM veicolo[\s\S]*?posti_totali >= \$3[\s\S]*?FOR UPDATE/));
test('Conflitti veicolo rivalidati prima di INSERT',()=>before('const busy = await conflittiVeicolo','INSERT INTO popbus_attivazioni'));
test('Persistenza dopo economia finale',()=>before('!finalEconomy.economicamenteAttivabile','INSERT INTO popbus_attivazioni'));
test('Rollback esplicito in catch',()=>{must("await client.query(\n          'ROLLBACK'");must('if (tx && client)');});
test('Socket dopo COMMIT',()=>{const c=source.lastIndexOf("await client.query('COMMIT')");const e=source.indexOf("'nuova_proposta_popbus'");assert.ok(c>=0&&e>c);});
test('Nessun avvio del worker da questo test',()=>assert.ok(!source.includes('SHADOW_TEST_AUTO_EXEC')));

console.log(`\n${pass}/${pass+fail} controlli strutturali superati; ${fail} errori.`);
console.log('AUDIT STATICO SHADOW: nessuna query, nessuna scrittura, nessuna attivazione.');
console.log('\n⚠️ Verifiche dinamiche NON dimostrate: rollback reale, race condition, lock DB, trigger, disponibilità corrente, pagamento finale.');
if(fail)process.exitCode=1;
