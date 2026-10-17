import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const path = new URL('../services/popbus/v2/acceptance.js', import.meta.url);
const src = fs.readFileSync(path, 'utf8');
let pass = 0;
function test(name, fn) {
  try { fn(); console.log('PASS', name); pass++; }
  catch (err) { console.error('FAIL', name, err.message); process.exitCode = 1; }
}
const worker = fs.readFileSync(new URL('../services/popbus/v2/worker.js', import.meta.url), 'utf8');
test('Guardia multi-missione conservata', () => assert.match(src, /Accettazione ciclo multi-missione non ancora abilitata/));
test('Lock transazionale globale conservato', () => assert.match(src, /pg_advisory_xact_lock\(734021, 1\)/));
test('Acceptance considera pending e confermate', () => assert.match(src, /other\.stato IN \('in_attesa_autista', 'confermata'\)/));
test('Worker considera pending e confermate', () => assert.match(worker, /a\.stato IN \('in_attesa_autista','confermata'\)/));
test('Esclusione della propria attivazione', () => assert.match(src, /other\.id <> \$1/));
test('Esclusivita sul veicolo', () => assert.match(src, /other\.veicolo_id = \$2/));
test('Sovrapposizione usa busyStart', () => assert.match(src, /other\.partenza\s*\)\s*< \$4::timestamptz/));
test('Sovrapposizione usa busyEnd', () => assert.match(src, /other\.arrivo\s*\)\s*> \$3::timestamptz/));
test('Gestione transazione demandata al router', () => assert.match(src, /BEGIN \/ COMMIT sono gestiti dal router/));
test('Verifica pagamento Stripe preservata', () => assert.match(src, /paymentIntents\.retrieve\(ref\)/));
test('Una prenotazione per richiesta preservata', () => assert.match(src, /for \(let i = 0; i < requests\.length; i\+\+\)/));
console.log(`ESITO: ${pass} PASS, ${process.exitCode ? 'FAIL presenti' : '0 FAIL'}. Test statici: nessuna connessione DB o Stripe.`);
