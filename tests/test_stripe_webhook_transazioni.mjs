// TEST ISOLATO DEL ROUTER STRIPE: nessuna rete, nessun database reale.
// Salvare come tests/test_stripe_webhook_transazioni.mjs
// Eseguire: node tests/test_stripe_webhook_transazioni.mjs routes/stripe-webhook.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const file = process.argv[2] || 'routes/stripe-webhook.js';
const source = fs.readFileSync(file, 'utf8');
const code = source.replace(/^import .*;\s*$/gm, '').replace(/^export \{ router \};?\s*$/gm, '');
const secret = 'whsec_test_isolato_turentu';
const key = 'sk_test_isolato';

function setup({ failCreate = false, failCommit = false } = {}) {
  const state = { stato: 'pendente', importo: 10, currency: 'eur', corsa_id: null, created: 0, commits: 0, rollbacks: 0, emitted: 0, captures: 0, queries: [] };
  let handler;
  let tail = Promise.resolve();
  const pool = { async connect() {
    // Simula un lock esclusivo del record pagamenti fino a COMMIT/ROLLBACK.
    let unlock;
    const myTurn = new Promise(resolve => { unlock = resolve; });
    const previous = tail;
    tail = myTurn;
    await previous;
    let snapshot;
    let released = false;
    return {
      async query(sql, params = []) {
        state.queries.push(sql.trim().split(/\s+/).slice(0, 4).join(' '));
        if (sql === 'BEGIN') { snapshot = { stato: state.stato, created: state.created }; return {}; }
        if (sql === 'COMMIT') {
          if (failCommit) throw Error('COMMIT simulato fallito');
          state.commits++; return {};
        }
        if (sql === 'ROLLBACK') { state.stato = snapshot.stato; state.created = snapshot.created; state.rollbacks++; return {}; }
        if (/SELECT p\.id/.test(sql)) return { rowCount: 1, rows: [{ id: 1, stato: state.stato, importo: state.importo, currency: state.currency, corsa_id: state.corsa_id }] };
        if (/UPDATE public\.pagamenti/.test(sql)) { state.stato = params[0]; return { rowCount: 1 }; }
        if (/FROM public\.veicolo/.test(sql)) return { rowCount: 1, rows: [{ id: 2 }] };
        throw Error('SQL non simulato: ' + sql.slice(0, 80));
      },
      release() { if (!released) { released = true; unlock(); } }
    };
  }};
  class StripeMock {
    constructor() { this.webhooks = { constructEvent(raw, signature, suppliedSecret) {
      if (suppliedSecret !== secret || !signature) throw Error('Firma assente o non valida');
      const match = /^t=(\d+),v1=([a-f0-9]+)$/.exec(signature);
      if (!match) throw Error('Firma non valida');
      const expected = crypto.createHmac('sha256', secret).update(`${match[1]}.${raw.toString()}`).digest('hex');
      if (expected !== match[2]) throw Error('Firma non valida');
      return JSON.parse(raw.toString());
    }};
    this.paymentIntents = { capture() { state.captures++; throw Error('Cattura proibita'); } };
    }
  }
  const context = vm.createContext({
    process: { env: { STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: secret } },
    express: { Router: () => ({ post(_path, _middleware, fn) { handler = fn; } }), raw: () => (_req, _res, next) => next() },
    Stripe: StripeMock, pool,
    pendingService: {
      async getPendingById(id) { return { id, veicolo_id: 2 }; },
      async updatePendingStatus() {}
    },
    async createCorsaFromPending() {
      if (failCreate) throw Error('Creazione corsa simulata fallita');
      state.created++;
      return { corsa: { id: 55 }, prenotazione: { id: 56 } };
    },
    getIO: () => ({ to: () => ({ emit: () => { state.emitted++; } }) }),
    console: { log() {}, warn() {}, error() {} }
  });
  vm.runInContext(code, context, { filename: file });
  function payload(type, metadata = { tipo: 'richiedi', pendingId: '12' }) {
    return Buffer.from(JSON.stringify({ id: 'evt_test', type, data: { object: { id: 'pi_test', status: 'succeeded', currency: 'eur', amount_received: 1000, metadata } } }));
  }
  async function send(raw, valid = true) {
    const t = Math.floor(Date.now() / 1000);
    const digest = crypto.createHmac('sha256', secret).update(`${t}.${raw.toString()}`).digest('hex');
    const req = { body: raw, headers: { 'stripe-signature': `t=${t},v1=${valid ? digest : 'bad'}` } };
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; }, send(x) { this.body = x; return this; } };
    await handler(req, res);
    return res;
  }
  return { state, payload, send };
}

test('firma non valida: HTTP 400 e nessuna transazione', async () => {
  const h = setup();
  const res = await h.send(h.payload('payment_intent.succeeded'), false);
  assert.equal(res.statusCode, 400);
  assert.equal(h.state.commits, 0);
});

test('richiedi duplicato simultaneo: una sola corsa, due HTTP 200', async () => {
  const h = setup();
  const raw = h.payload('payment_intent.succeeded');
  const [a, b] = await Promise.all([h.send(raw), h.send(raw)]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(h.state.created, 1);
  assert.equal(h.state.stato, 'pagato');
  assert.equal(h.state.captures, 0);
});

test('errore creazione corsa: rollback e HTTP 500', async () => {
  const h = setup({ failCreate: true });
  const res = await h.send(h.payload('payment_intent.succeeded'));
  assert.equal(res.statusCode, 500);
  assert.equal(h.state.stato, 'pendente');
  assert.equal(h.state.rollbacks, 1);
  assert.equal(h.state.created, 0);
});

test('COMMIT fallito: rollback e nessuna conferma Socket.IO prematura', async () => {
  const h = setup({ failCommit: true });
  const res = await h.send(h.payload('payment_intent.succeeded'));
  assert.equal(res.statusCode, 500);
  assert.equal(h.state.stato, 'pendente');
  assert.equal(h.state.rollbacks, 1);
  assert.equal(h.state.emitted, 0, 'BUG: notifica emessa prima del COMMIT');
});
