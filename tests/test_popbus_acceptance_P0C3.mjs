// POPBUS P0-C3 — test statici e contratto, nessun DB o Stripe.
// Eseguire dopo aver rinominato questo file .mjs nella cartella tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const s = readFileSync('services/popbus/v2/acceptance.js', 'utf8');
let pass = 0;
function test(name, fn) { fn(); pass++; console.log('PASS ' + name); }
test('Flag sperimentale disabilitato per default', () => assert.match(s, /process\.env\.POPBUS_MULTIMISSION_ACCEPTANCE_TEST === 'true'/));
test('Guardia attiva con flag disabilitato', () => assert.match(s, /if \(!multiEnabled\)\s*\{\s*throw new Error\('Accettazione ciclo multi-missione non ancora abilitata'\)/));
test('Validazione strutturale prima della conversione', () => assert(s.indexOf('validaPianoMultiMissione(plan') < s.indexOf('INSERT INTO corse')));
test('Preflight relazionale prima della conversione', () => assert(s.indexOf('await verificaMissioniPersistite(client') < s.indexOf('INSERT INTO corse')));
test('Picco reale letto dal preflight', () => assert.match(s, /isMulti \? multiPreflight\.peak : plan\.evaluation\.peak/g));
test('Indici globali confrontati con il piano', () => assert.match(s, /P0-C3: richieste o indici globali non coerenti/));
test('Snapshot obbligatorio e fingerprint conservato', () => { assert.match(s, /P0-C3: snapshot richieste incompleto/); assert.match(s, /fingerprintRichiesta\(r\)/); });
test('Una corsa, prenotazioni e pagamenti per richiesta', () => { assert.equal((s.match(/INSERT INTO corse\s*\(/g)||[]).length,1); assert.match(s, /for \(let i = 0; i < requests\.length; i\+\+\)/); assert.match(s, /INSERT INTO prenotazioni/); assert.match(s, /INSERT INTO pagamenti/); });
test('Nessun BEGIN COMMIT ROLLBACK nel modulo', () => { assert.doesNotMatch(s, /await client\.query\(\s*['"`]\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i); });
test('Stati e pagamento verificati', () => { assert.match(s, /await verificaPagamento\(client, r\)/); assert.match(s, /UPDATE popbus_attivazioni/); assert.match(s, /UPDATE offerte_autisti/); });
test('Conflitti veicolo per attivazioni pending e confermate', () => assert.match(s, /other\.stato IN \('in_attesa_autista', 'confermata'\)/));
test('Validazione avvicinamento e ritorno', () => assert.match(s, /P0-C3: avvicinamento o ritorno non validi/));
console.log(`ESITO: ${pass} PASS, 0 FAIL. Verifiche statiche: NO database, NO Stripe, NO rollback reale.`);
