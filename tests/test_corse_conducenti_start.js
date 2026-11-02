// TURENTU - test START senza DB, Redis o Stripe reali.
// Salvare come tests/test_corse_conducenti_start.js
// Eseguire: node tests/test_corse_conducenti_start.js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const serviceUrl = new URL('../services/corsa/corse.service.js', import.meta.url);
let source = await readFile(serviceUrl, 'utf8');
// Rimuove esclusivamente gli import esterni: il corpo reale del servizio rimane intatto.
const importLines = source.match(/^import .*;\s*$/gm) ?? [];
assert.equal(importLines.length, 5, 'Import del servizio cambiati: aggiornare il test');
source = source.replace(/^import .*;\s*$/gm, '');
assert.match(source, /const stripe = new Stripe\(process\.env\.STRIPE_SECRET_KEY\);/);
source = source.replace(
  'const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);',
  'const stripe = { paymentIntents: { capture: async () => { throw new Error("STRIPE_NON_DEVE_ESSERE_CHIAMATO"); } } };'
);
const calls = [];
let scenario = '';
let state = 'accettata';
const fakeClient = {
  async query(sql, params = []) {
    const s = String(sql).trim();
    calls.push({ sql: s, params });
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (s.startsWith('UPDATE public.corse')) {
      if (state !== 'accettata') return { rows: [], rowCount: 0 };
      state = 'in_corso';
      return { rows: [{ id: 923, veicolo_id: 364, stato: state }], rowCount: 1 };
    }
    if (s.startsWith('SELECT stato FROM public.corse')) return { rows: [{ stato: state }], rowCount: 1 };
    if (s.includes('FROM public.assegnazioni_conducenti ac')) {
      assert.match(s, /ac\.conducente_id\s*=\s*\$2/);
      assert.match(s, /ac\.stato\s*=\s*'assegnata'/);
      assert.match(s, /FOR UPDATE OF ac/);
      return { rows: scenario === 'assegnato' ? [{ id: 42 }] : [], rowCount: scenario === 'assegnato' ? 1 : 0 };
    }
    throw new Error('Query inattesa nel test START: ' + s.slice(0, 140));
  },
  release() {}
};
const pool = { connect: async () => fakeClient };
const CacheManager = { corsa: { update() {} } };
const removeCorsa = async () => {};
const getTariffe = async () => { throw new Error('getTariffe non previsto in START'); };
const calcolaPrezzo = () => { throw new Error('calcolaPrezzo non previsto in START'); };
const prefix = 'const { pool, CacheManager, removeCorsa, getTariffe, calcolaPrezzo } = globalThis.__turentuStartTest;\n';
globalThis.__turentuStartTest = { pool, CacheManager, removeCorsa, getTariffe, calcolaPrezzo };
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(prefix + source).toString('base64');
const { toggleCorsa } = await import(moduleUrl);

async function checkForbidden(label, userId) {
  scenario = 'nessuna'; state = 'accettata'; calls.length = 0;
  await assert.rejects(() => toggleCorsa(923, 'start', userId), e => e.status === 403);
  assert.ok(calls.some(c => c.sql === 'ROLLBACK'), 'ROLLBACK mancante');
  assert.ok(!calls.some(c => c.sql === 'COMMIT'), 'COMMIT non atteso');
  console.log('OK - ' + label + ': 403 e ROLLBACK');
}
await checkForbidden('conducente senza assegnazione', 99);
await checkForbidden('titolare non assegnato', 2);
await checkForbidden('assegnazione annullata/non valida', 99);
scenario = 'assegnato'; state = 'accettata'; calls.length = 0;
const result = await toggleCorsa(923, 'start', 99);
assert.equal(result.stato, 'in_corso');
assert.ok(calls.some(c => c.sql === 'COMMIT'));
assert.ok(!calls.some(c => c.sql === 'ROLLBACK'));
console.log('OK - conducente assegnato: START e COMMIT');
console.log('PASS - test simulati; nessuna connessione al DB, Redis o Stripe');
delete globalThis.__turentuStartTest;
