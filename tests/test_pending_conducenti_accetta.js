// TURENTU - test isolato della rotta NCC di accettazione.
// Copiare in tests/test_pending_conducenti_accetta.js
// Eseguire: node tests/test_pending_conducenti_accetta.js
// Non utilizza PostgreSQL, Redis, Socket.IO o Stripe reali.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let source = await readFile(new URL('../routes/pending.routes.js', import.meta.url), 'utf8');
const imports = source.match(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm) ?? [];
assert.equal(imports.length, 12, 'Import cambiati: aggiornare il test prima di procedere');
source = source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '');
assert.match(source, /const stripe = new Stripe\(process\.env\.STRIPE_SECRET_KEY\);/);
source = source.replace('const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);', 'const stripe = globalThis.__pendingTest.stripe;');
source = source.replace('export { router as pendingRouter };', 'export { router as pendingRouter };');

let scenario, calls, assignments, notifications, pendingState, committed, routeHandler;
const pending = () => ({ id: 31, stato: pendingState, veicolo_id: 364, cliente_id: 18, tipo_corsa: 'privata', corsa_id: null, tratta_id: null, start_datetime: '2030-06-10T10:00:00+02:00', durata: '01:00:00', durata_minuti: 60, expires_at: '2030-06-10T09:30:00+02:00', origine_address: 'A', destinazione_address: 'B', origine_lat: 40, origine_lon: 18, destinazione_lat: 40.2, destinazione_lon: 18.2, posti_richiesti: 1, payment_intent_id: null, prezzo: 20 });
const corsa = () => ({ id: 923, veicolo_id: 364, tipo_corsa: 'privata', stato: 'prenotabile', cicloOperativoNcc: { inizio: '2030-06-10T09:00:00+02:00', fine: '2030-06-10T12:00:00+02:00' }, prenotazione_origine_id: 701 });
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
    if (s.includes('FROM veicolo') && s.includes('lat_base')) return { rows: [{ id: 364, posti_totali: 8, lat_base: 40, lon_base: 18 }], rowCount: 1 };
    if (s.startsWith('UPDATE pending SET corsa_id')) return { rows: [], rowCount: 1 };
    if (s.startsWith('UPDATE corse') && s.includes('origine_address')) return { rows: [], rowCount: 1 };
    if (s.startsWith('UPDATE corse') && s.includes('fermate_pianificate')) return { rows: [corsa()], rowCount: 1 };
    if (s.includes('SELECT id FROM prenotazioni')) return { rows: [{ id: 701 }], rowCount: 1 };
    if (s.startsWith('INSERT INTO chat_threads')) return { rows: [], rowCount: 1 };
    throw new Error('Query inattesa: ' + s.slice(0, 160));
  }, release() {}
};
const pool = { connect: async () => fakeClient, query: async (sql) => { calls.push({ sql: String(sql), outside: true }); throw new Error('PENDING_RIFIUTATO_INDEBITAMENTE'); } };
const router = { use() {}, get() {}, post(path, fn) { if (path === '/:id/accetta') routeHandler = fn; } };
const express = { Router: () => router };
const stripe = { paymentIntents: { retrieve: async () => { throw new Error('STRIPE_NON_PREVISTO'); } } };
const mock = {
  express, stripe, pool, authMiddleware: () => {},
  getIO: () => ({ to: () => ({ emit() {} }) }),
  prenotaCorsa: async () => ({ id: 701 }),
  createCorsaFromPending: async () => ({ corsa: corsa() }),
  assegnaConducente: async (client, data) => {
    assert.equal(client, fakeClient);
    assignments.push(data);
    if (scenario.error) { const e = new Error('Assegnazione non consentita'); e.code = scenario.error; throw e; }
    return { id: 42 };
  },
  upsertCorsa: () => {}, upsertTratta: async () => {},
  CacheManager: { corsa: { update() {} } },
  notifyUser: async () => { notifications++; },
  bloccaVeicoloPerAssegnazione: async () => {},
  verificaTrasferimentiVeicolo: async () => ({ compatibile: true })
};
globalThis.__pendingTest = mock;
const prefix = 'const { express, pool, authMiddleware, getIO, prenotaCorsa, createCorsaFromPending, assegnaConducente, upsertCorsa, upsertTratta, CacheManager, notifyUser, bloccaVeicoloPerAssegnazione, verificaTrasferimentiVeicolo } = globalThis.__pendingTest;\n';
await import('data:text/javascript;base64,' + Buffer.from(prefix + source).toString('base64'));
assert.equal(typeof routeHandler, 'function');

async function run(label, choice, error, expectedStatus, expectedCommit) {
  scenario = { error }; calls = []; assignments = []; notifications = 0; pendingState = 'pending'; committed = false;
  const oldFlag = process.env.NCC_CONDUCENTI_ENABLED;
  process.env.NCC_CONDUCENTI_ENABLED = 'true';
  const response = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  const oldLog = console.log, oldError = console.error;
  console.log = () => {}; console.error = () => {};
  try { await routeHandler({ params: { id: '31' }, user: { id: 2 }, body: { conducente: choice } }, response); }
  finally { console.log = oldLog; console.error = oldError; if (oldFlag === undefined) delete process.env.NCC_CONDUCENTI_ENABLED; else process.env.NCC_CONDUCENTI_ENABLED = oldFlag; }
  assert.equal(response.statusCode, expectedStatus, label + ': HTTP');
  assert.equal(committed, expectedCommit, label + ': COMMIT');
  assert.equal(pendingState, expectedCommit ? 'accettata' : 'pending', label + ': pending');
  assert.equal(assignments.length, 1, label + ': assegnazione una sola volta');
  if (!expectedCommit) {
    assert.ok(calls.some(x => x.sql === 'ROLLBACK'), label + ': ROLLBACK');
    assert.ok(!calls.some(x => x.outside), label + ': pending non rifiutato');
    assert.equal(response.body.code, error);
    assert.equal(notifications, 0, label + ': nessuna notifica');
  }
  console.log('OK - ' + label);
}
await run('manuale valida: COMMIT', { modalita: 'manuale', conducenteId: 99 }, null, 200, true);
await run('automatica valida: COMMIT', { modalita: 'automatica' }, null, 200, true);
await run('conducente occupato: ROLLBACK e pending recuperabile', { modalita: 'manuale', conducenteId: 99 }, 'CONDUCENTE_CONFLITTO', 409, false);
await run('modalita non consentita: ROLLBACK e HTTP 409', { modalita: 'automatica' }, 'MODALITA_ASSEGNAZIONE_NON_CONSENTITA', 409, false);
await run('titolare non disponibile: ROLLBACK', { modalita: 'titolare' }, 'CONDUCENTE_NON_DISPONIBILE', 409, false);
console.log('PASS - 5 scenari simulati; nessun DB, Redis o Stripe reale');
delete globalThis.__pendingTest;
