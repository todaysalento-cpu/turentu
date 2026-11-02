// TURENTU - condivisa NCC esistente: nessuna nuova assegnazione conducente.
// Salvare come tests/test_pending_condivisa_conducente.js
// Eseguire: node tests/test_pending_condivisa_conducente.js
// Test isolato: nessun DB, Redis o Stripe reale.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let source = await readFile(new URL('../routes/pending.routes.js', import.meta.url), 'utf8');
const imports = source.match(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm) ?? [];
assert.equal(imports.length, 12, 'Import cambiati: aggiornare il test');
source = source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '');
assert.match(source, /const stripe = new Stripe\(process\.env\.STRIPE_SECRET_KEY\);/);
source = source.replace('const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);', 'const stripe = globalThis.__turentuCondivisaTest.stripe;');

let handler;
let calls = [], assignments = 0, creations = 0, bookings = 0, captures = 0, notifications = 0, committed = false;
let pendingState = 'pending';
const pending = () => ({
  id: 32, stato: pendingState, veicolo_id: 364, cliente_id: 19,
  tipo_corsa: 'condivisa', corsa_id: 923, tratta_id: 101,
  start_datetime: '2030-06-10T10:30:00+02:00', durata_minuti: 30,
  expires_at: '2030-06-10T10:00:00+02:00',
  origine_address: 'Salita', destinazione_address: 'Discesa',
  origine_lat: 40.1, origine_lon: 18.1, destinazione_lat: 40.2, destinazione_lon: 18.2,
  posti_richiesti: 1, start_index_polyline: 1, end_index_polyline: 2,
  start_offset: 10000, end_offset: 20000,
  payment_intent_id: 'pi_test_mock', prezzo: 15
});
const corsa = () => ({ id: 923, veicolo_id: 364, tipo_corsa: 'condivisa', stato: 'prenotabile',
  prezzo_fisso: 40, prenotazione_origine_id: 700 });
const fakeClient = {
  async query(sql, params = []) {
    const s = String(sql).trim(); calls.push({ sql: s, params });
    if (s === 'BEGIN') return { rows: [], rowCount: 0 };
    if (s === 'COMMIT') { committed = true; return { rows: [], rowCount: 0 }; }
    if (s === 'ROLLBACK') { pendingState = 'pending'; return { rows: [], rowCount: 0 }; }
    if (s.includes('FROM pending') && s.includes('FOR UPDATE')) return { rows: [pending()], rowCount: 1 };
    if (s.startsWith('SELECT driver_id FROM veicolo')) return { rows: [{ driver_id: 2 }], rowCount: 1 };
    if (s.startsWith('UPDATE pending SET stato')) { pendingState = 'accettata'; return { rows: [pending()], rowCount: 1 }; }
    if (s.includes('u.nome AS driver_nome')) return { rows: [{ driver_id: 2, driver_nome: 'Operatore' }], rowCount: 1 };
    if (s.startsWith('SELECT * FROM corse WHERE id')) return { rows: [corsa()], rowCount: 1 };
    if (s.includes('FROM public.corse_tratte t')) return { rows: [{
      id: 101, corsa_id: 923, direzione: 'andata', stato_temporale: 'programmato',
      partenza_prevista: '2030-06-10T10:20:00+02:00', durata_secondi: 3600,
      distanza_km: 60, arrivo_andata: '2030-06-10T11:20:00+02:00', km_andata: 60
    }], rowCount: 1 };
    if (s.startsWith('UPDATE corse') && s.includes('fermate_pianificate')) return { rows: [corsa()], rowCount: 1 };
    if (s.includes('SELECT pr.prezzo_totale')) return { rows: [{ prezzo_totale: 12, prezzo_fisso: 40, prenotazione_origine_id: 700 }], rowCount: 1 };
    if (s.startsWith('INSERT INTO pagamenti')) return { rows: [], rowCount: 1 };
    if (s.startsWith('INSERT INTO chat_threads')) return { rows: [], rowCount: 1 };
    throw new Error('Query inattesa: ' + s.slice(0, 170));
  }, release() {}
};
const pool = { connect: async () => fakeClient, query: async () => { throw new Error('PENDING_NON_DEVE_ESSERE_RIFIUTATO'); } };
const router = { use() {}, get() {}, post(path, fn) { if (path === '/:id/accetta') handler = fn; } };
const mock = {
  express: { Router: () => router }, pool, authMiddleware: () => {},
  stripe: { paymentIntents: { retrieve: async (id) => {
    assert.equal(id, 'pi_test_mock'); captures++;
    return { status: 'requires_capture', amount_capturable: 1500, amount: 1500 };
  } } },
  getIO: () => ({ to: () => ({ emit() {} }) }),
  prenotaCorsa: async () => { bookings++; return { id: 702 }; },
  createCorsaFromPending: async () => { creations++; throw new Error('NUOVA_CORSA_VIETATA'); },
  assegnaConducente: async () => { assignments++; throw new Error('ASSEGNAZIONE_DUPLICATA'); },
  upsertCorsa: () => {}, upsertTratta: async () => {},
  CacheManager: { corsa: { update() {} } },
  notifyUser: async () => { notifications++; },
  bloccaVeicoloPerAssegnazione: async () => {},
  verificaTrasferimentiVeicolo: async () => { throw new Error('VERIFICA_NUOVA_MISSIONE_VIETATA'); }
};
globalThis.__turentuCondivisaTest = mock;
const prefix = 'const { express, pool, authMiddleware, getIO, prenotaCorsa, createCorsaFromPending, assegnaConducente, upsertCorsa, upsertTratta, CacheManager, notifyUser, bloccaVeicoloPerAssegnazione, verificaTrasferimentiVeicolo } = globalThis.__turentuCondivisaTest;\n';
await import('data:text/javascript;base64,' + Buffer.from(prefix + source).toString('base64'));
assert.equal(typeof handler, 'function');

const previousFlag = process.env.NCC_CONDUCENTI_ENABLED;
process.env.NCC_CONDUCENTI_ENABLED = 'true';
const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
const originalLog = console.log, originalError = console.error;
console.log = () => {}; console.error = () => {};
try {
  await handler({ params: { id: '32' }, user: { id: 2 }, body: { conducente: { modalita: 'manuale', conducenteId: 99 } } }, res);
} finally {
  console.log = originalLog; console.error = originalError;
  if (previousFlag === undefined) delete process.env.NCC_CONDUCENTI_ENABLED;
  else process.env.NCC_CONDUCENTI_ENABLED = previousFlag;
  delete globalThis.__turentuCondivisaTest;
}
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.deepEqual(res.body, { ok: true });
assert.equal(committed, true);
assert.equal(pendingState, 'accettata');
assert.equal(assignments, 0, 'La condivisa esistente non deve riassegnare il conducente');
assert.equal(creations, 0, 'La condivisa esistente non deve creare una corsa');
assert.equal(bookings, 1, 'Deve creare una sola prenotazione');
assert.equal(captures, 1, 'Deve verificare una volta la autorizzazione Stripe simulata');
assert.equal(notifications, 1);
assert.ok(!calls.some(x => x.sql === 'ROLLBACK'));
assert.ok(!calls.some(x => x.sql.startsWith('UPDATE corse') && x.sql.includes('origine_address')),
  'Gli indirizzi della missione esistente non devono essere sovrascritti');
console.log('OK - condivisa esistente: prenotazione aggiunta e COMMIT');
console.log('OK - nessuna nuova corsa, nessuna assegnazione conducente duplicata');
console.log('OK - indirizzi della missione preservati, verifica Stripe simulata');
console.log('PASS - test condivisa NCC isolato; nessun DB, Redis o Stripe reale');
