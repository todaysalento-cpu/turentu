// TURENTU POPBUS P0-C5C - Audit + SQL mock direttrici virtuali.
// Nessun collegamento PostgreSQL/Stripe. Non esegue l'intera acceptance.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const file = path.resolve('services/popbus/v2/acceptance.js');
const src = readFileSync(file, 'utf8');
let pass = 0;
function check(name, fn) {
  try { fn(); console.log('PASS', name); pass++; }
  catch (e) { console.error('FAIL', name, e.message); process.exitCode = 1; }
}

const begin = src.indexOf('  // P0-C5C. CONFLITTI DIRETTRICI VIRTUALI LEGACY');
const end = src.indexOf('  // 6. LOCK RICHIESTE POPBUS', begin);
const section = begin >= 0 && end > begin ? src.slice(begin, end) : '';
check('Sezione P0-C5C presente', () => assert.ok(section.length > 500));
check('Controllo prima del lock richieste e INSERT corse', () => {
  assert.ok(begin < src.indexOf('INSERT INTO corse'));
  assert.ok(begin < end);
});
check('Esclusivita per veicolo_id', () => assert.match(section, /d\.veicolo_id\s*=\s*\$1/));
check('Stati allineati al worker', () => assert.match(section, /'in_attesa_autista', 'attivo', 'confermata'/));
check('Durata segmenti con tempo stimato', () => assert.match(section, /s\.start_datetime\s*\+\s*s\.tempo_stimato\s*\*\s*INTERVAL/));
check('Confronto su busyStart e busyEnd', () => {
  assert.match(section, /\[a\.veicolo_id, busyStart, busyEnd,/);
  assert.match(section, /HAVING MAX\(/);
});
check('Esclusione direttrice propria', () => assert.match(section, /d\.id\s*<>\s*\$4::bigint/));
check('Esclusione direttrici gia rappresentate da attivazioni', () => assert.match(section, /NOT EXISTS[\s\S]*other\.direttrice_id\s*=\s*d\.id/));
check('Nessuna transazione autonoma', () => {
  assert.doesNotMatch(section, /client\.query\(['"`]\s*(?:BEGIN|COMMIT|ROLLBACK)/i);
});
check('Guardia multi-missione e flag conservati', () => {
  assert.match(src, /POPBUS_MULTIMISSION_ACCEPTANCE_TEST/);
  assert.match(src, /Accettazione ciclo multi-missione non ancora abilitata/);
});

// Esegue esclusivamente il blocco estratto con un client fittizio:
// verifica che i parametri siano quelli del veicolo e dell'intervallo operativo,
// e che una riga di conflitto interrompa il flusso.
async function runBlock(rows) {
  let sql, args;
  const client = { query: async (q, p) => { sql = q; args = p; return { rows }; } };
  const a = { id: 90, veicolo_id: 353, direttrice_id: 777 };
  const busyStart = new Date('2026-10-20T07:00:00Z');
  const busyEnd = new Date('2026-10-20T15:00:00Z');
  const offertaId = 500;
  const fn = new Function('client', 'a', 'busyStart', 'busyEnd', 'offertaId',
    `return (async () => { ${section} })()`);
  let error;
  try { await fn(client, a, busyStart, busyEnd, offertaId); }
  catch (e) { error = e; }
  return { sql, args, error };
}

const free = await runBlock([]);
check('SQL mock: nessuna direttrice conflittuale consente', () => assert.equal(free.error, undefined));
check('SQL mock: parametri veicolo, intervallo e direttrice propria', () => {
  assert.equal(free.args[0], 353);
  assert.equal(free.args[1].toISOString(), '2026-10-20T07:00:00.000Z');
  assert.equal(free.args[2].toISOString(), '2026-10-20T15:00:00.000Z');
  assert.equal(free.args[3], 777);
});
const conflict = await runBlock([{ id: 999 }]);
check('SQL mock: altra direttrice sovrapposta blocca', () =>
  assert.match(conflict.error?.message ?? '', /altra direttrice virtuale/));
console.log(`ESITO: ${pass} PASS, ${process.exitCode ? 1 : 0} FAIL. SQL MOCK; NO DB/Stripe; concorrenza reale NON verificata.`);
