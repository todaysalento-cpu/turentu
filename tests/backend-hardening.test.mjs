import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import jwt from 'jsonwebtoken';
import express from 'express';
import ngeohash from 'ngeohash';
import polyline from '@mapbox/polyline';

// Carica il codice reale con dipendenze isolate: nessuna connessione esterna.
async function isolated(path, dependencies = {}, env = {}) {
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    process: { env }, URL, Date, Map, Set, AggregateError,
  });
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => {
    assert.ok(Object.hasOwn(dependencies, specifier), `Dipendenza non simulata: ${specifier}`);
    const exports = dependencies[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

test('configurazione: JWT obbligatorio, nessun fallback', async () => {
  await assert.rejects(isolated('config/security.js', { 'dotenv/config': {} }), /JWT_SECRET obbligatorio/);
  const config = await isolated('config/security.js', { 'dotenv/config': {} }, { JWT_SECRET: 'private-test-secret' });
  assert.throws(() => config.readJwtSecret({ JWT_SECRET: 'segreto-di-test' }), /JWT_SECRET/);
  assert.throws(() => config.readJwtSecret({ JWT_SECRET: '  ' }), /JWT_SECRET/);
  assert.equal(config.readJwtSecret({ JWT_SECRET: 'configured' }), 'configured');
});

test('database: nessuna credenziale fallback e TLS non aggirabile dalla URL', async () => {
  const { databaseOptions } = await isolated('config/database.js', { 'dotenv/config': {} });
  assert.throws(() => databaseOptions({}), /DATABASE_URL/);
  const config = databaseOptions({ DATABASE_URL: 'postgres://user:password@db.example/app?sslmode=no-verify' });
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(new URL(config.connectionString).searchParams.has('sslmode'), false);
  assert.throws(() => databaseOptions({ DATABASE_URL: 'postgres://db.example/app', DATABASE_SSL_MODE: 'disable' }), /TLS/);
  assert.throws(() => databaseOptions({ DATABASE_URL: 'postgres://localhost/app', DATABASE_SSL_MODE: 'disable', NODE_ENV: 'production' }), /TLS/);
  assert.equal(databaseOptions({ DATABASE_URL: 'postgres://localhost/app', DATABASE_SSL_MODE: 'disable' }).ssl, false);
  assert.equal(databaseOptions({ DATABASE_URL: 'postgres://db.example/app', DATABASE_SSL_CA: 'a\\nb' }).ssl.ca, 'a\nb');
});

test('router admin: blocca anonimi e clienti prima di qualsiasi endpoint', async () => {
  const secret = 'isolated-admin-test-secret';
  const auth = await isolated('middleware/auth.js', {
    jsonwebtoken: { default: jwt }, '../config/security.js': { JWT_SECRET: secret },
  });
  const dependencies = {
    express: { default: express }, '../../middleware/auth.js': auth,
  };
  for (const name of ['dashboard', 'pagamenti', 'gestione', 'report', 'impostazioni', 'notifications', 'veicoli', 'corse', 'pending', 'live']) {
    dependencies[`./${name}.routes.js`] = { default: express.Router() };
  }
  const { default: router } = await isolated('routes/admin/index.js', dependencies);
  const guards = router.stack.slice(0, 2).map(layer => layer.handle);
  function authorize(token) {
    let status = 200, calls = 0;
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = { status(code) { status = code; return this; }, json() {} };
    guards[0](req, res, () => guards[1](req, res, () => calls++));
    return { status, calls };
  }
  assert.deepEqual(authorize(), { status: 401, calls: 0 });
  assert.deepEqual(authorize(jwt.sign({ id: 1, role: 'cliente' }, secret)), { status: 403, calls: 0 });
  assert.deepEqual(authorize(jwt.sign({ id: 1, role: 'admin' }, 'wrong')), { status: 401, calls: 0 });
  for (const role of ['admin', 'Admin']) {
    assert.deepEqual(authorize(jwt.sign({ id: 1, role }, secret)), { status: 200, calls: 1 });
  }
});

async function paymentsFixture({ rows, intent, failedCommit = false } = {}) {
  const payment = { id: 7, stato: 'autorizzazione', importo: '10.00', prezzo_totale: '10.00', currency: 'eur', stripe_payment_intent: 'pi_test' };
  const queries = [], accounting = [], calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM public.corse')) return { rows: [{ id: 4 }] };
      if (sql.includes('FROM public.pagamenti p')) return { rows: rows ?? [payment] };
      if (sql === 'COMMIT' && failedCommit) throw new Error('commit failed');
      return { rows: [], rowCount: 1 };
    },
    release() { released = true; },
  };
  const module = await isolated('services/payments/admin-reconciliation.service.js', {
    './contabilizzazione.service.js': { contabilizzaPagamento: async (_, id) => accounting.push(id) },
  });
  const confirmed = {
    id: 'pi_test', status: 'succeeded', currency: 'eur', amount_received: 1000,
    latest_charge: { payment_intent: 'pi_test', currency: 'eur', status: 'succeeded', amount: 2000, captured: true, amount_captured: 1000, refunded: false, amount_refunded: 0 },
  };
  return {
    payment, confirmed, queries, accounting, calls,
    released: () => released,
    run: (overrides = {}) => module.reconcileAdminPayment({
      pool: { connect: async () => client },
      stripe: { paymentIntents: { retrieve: async (...args) => { calls.push(args); return intent ?? confirmed; } } },
      corsaId: '4', action: 'rilascia', ...overrides,
    }),
  };
}

test('pagamenti: azioni errate e ID invalidi non acquisiscono connessioni', async () => {
  const f = await paymentsFixture();
  await assert.rejects(f.run({ action: 'typo' }), error => error.status === 400);
  await assert.rejects(f.run({ corsaId: '4 OR 1=1' }), error => error.status === 400);
  await assert.rejects(f.run({ stripe: null }), error => error.status === 503);
  assert.equal(f.queries.length, 0);
});

test('pagamenti: piu pagamenti richiedono selezione esplicita e non aggiornano il DB', async () => {
  const f = await paymentsFixture({ rows: [{ id: 7 }, { id: 8 }] });
  await assert.rejects(f.run(), error => error.status === 409);
  assert.equal(f.calls.length, 0);
  assert.equal(f.queries.some(q => q.sql.startsWith('UPDATE')), false);
  assert.equal(f.queries.at(-1).sql, 'ROLLBACK');
  assert.equal(f.released(), true);
});

test('pagamenti: autorizzazione non acquisita e importo errato non diventano pagati', async () => {
  for (const intent of [
    { id: 'pi_test', status: 'requires_capture', currency: 'eur', amount_received: 0 },
    { id: 'pi_test', status: 'succeeded', currency: 'eur', amount_received: 999 },
  ]) {
    const f = await paymentsFixture({ intent });
    await assert.rejects(f.run(), error => error.status === 409);
    assert.equal(f.queries.some(q => q.sql.startsWith('UPDATE')), false);
    assert.equal(f.queries.at(-1).sql, 'ROLLBACK');
  }
});

test('pagamenti: incasso verificato aggiorna un pagamento e contabilizza prima del commit', async () => {
  const f = await paymentsFixture();
  const result = await f.run({ paymentId: '7' });
  assert.equal(result.stato, 'pagato');
  assert.equal(result.pagamento_id, 7);
  assert.deepEqual(Array.from(f.queries.find(q => q.sql.startsWith('UPDATE')).params), ['pagato', 10, 7]);
  assert.deepEqual(f.accounting, [7]);
  assert.equal(f.queries.at(-1).sql, 'COMMIT');
  assert.equal(f.released(), true);
});

test('pagamenti: rimborso assente o parziale non viene dichiarato completo', async () => {
  for (const refundedAmount of [0, 500]) {
    const f = await paymentsFixture({
      rows: [{ id: 7, stato: 'pagato', importo: 10, currency: 'eur', stripe_payment_intent: 'pi_test' }],
      intent: { id: 'pi_test', status: 'succeeded', currency: 'eur', amount_received: 1000,
        latest_charge: { payment_intent: 'pi_test', currency: 'eur', status: 'succeeded', amount: 1000, captured: true, amount_captured: 1000, refunded: false, amount_refunded: refundedAmount } },
    });
    await assert.rejects(f.run({ action: 'rimborso' }), error => error.status === 409);
    assert.equal(f.queries.some(q => q.sql.startsWith('UPDATE')), false);
  }
});

test('pagamenti: rimborso completo gia eseguito viene riconciliato, senza chiamate mutative Stripe', async () => {
  const f = await paymentsFixture({
    rows: [{ id: 7, stato: 'pagato', importo: 10, currency: 'eur', stripe_payment_intent: 'pi_test' }],
    intent: { id: 'pi_test', status: 'succeeded', currency: 'eur', amount_received: 1000,
      latest_charge: { payment_intent: 'pi_test', currency: 'eur', status: 'succeeded', amount: 1000, captured: true, amount_captured: 1000, refunded: true, amount_refunded: 1000 } },
  });
  assert.equal((await f.run({ action: 'rimborso' })).stato, 'rimborsato');
  assert.equal(f.accounting.length, 0);
  assert.equal(f.queries.at(-1).sql, 'COMMIT');
});

test('pagamenti: errore al commit comporta rollback e release', async () => {
  const f = await paymentsFixture({ failedCommit: true });
  await assert.rejects(f.run(), /commit failed/);
  assert.equal(f.queries.at(-1).sql, 'ROLLBACK');
  assert.equal(f.released(), true);
});

test('pagamenti: wallet non passa dalla riconciliazione Stripe', async () => {
  const f = await paymentsFixture({ rows: [{ id: 7, stato: 'pagato', importo: 10, stripe_payment_intent: 'wallet_123' }] });
  await assert.rejects(f.run(), error => error.status === 409);
  assert.equal(f.calls.length, 0);
  assert.equal(f.queries.some(q => q.sql.startsWith('UPDATE')), false);
});

async function cacheFixture() {
  const state = { disponibilita: [], veicoli: [], corse: [], tratte: [], queryCount: 0, connects: 0, released: 0, failRedis: false, onExec: null };
  const keys = new Map(), sets = new Map();
  const redis = {
    async get(key) { return keys.get(key); },
    async sRem(key, id) { sets.get(key)?.delete(id); },
    multi() {
      const commands = [];
      const tx = {};
      for (const op of ['sRem', 'sAdd', 'set', 'del']) tx[op] = (...args) => { commands.push([op, ...args]); return tx; };
      tx.exec = async () => {
        if (state.failRedis) throw new Error('redis offline');
        if (state.onExec) { const hook = state.onExec; state.onExec = null; await hook(); }
        for (const [op, key, value] of commands) {
          if (op === 'set') keys.set(key, value);
          if (op === 'del') keys.delete(key);
          if (op === 'sAdd') { if (!sets.has(key)) sets.set(key, new Set()); sets.get(key).add(value); }
          if (op === 'sRem') sets.get(key)?.delete(value);
        }
      };
      return tx;
    },
  };
  const pool = {
    async connect() {
      state.connects++;
      return {
        async query(sql) {
          state.queryCount++;
          if (sql.includes('FROM disponibilita_veicolo')) {
            assert.equal(sql.includes('LIMIT 100'), false);
            return { rows: structuredClone(state.disponibilita) };
          }
          if (sql.includes('FROM veicolo')) return { rows: structuredClone(state.veicoli) };
          if (sql.includes('FROM corse c')) return { rows: structuredClone(state.corse) };
          if (sql.includes('public.corse_tratte')) return { rows: structuredClone(state.tratte) };
          return { rows: [] };
        },
        release() { state.released++; },
      };
    },
  };
  const cache = await isolated('services/search/search.cache.js', {
    '../../db/db.js': { pool }, ngeohash: { default: ngeohash },
    '@mapbox/polyline': { default: polyline }, '../../redis.js': { redisClient: redis },
  });
  return { state, keys, sets, cache };
}

const availability = (id, vehicle = id) => ({ id, veicolo_id: vehicle, driver_id: 1, start: '08:00', fine: '18:00', lat_base: 40, lon_base: 18 });

test('cache: oltre 100 disponibilita, un solo caricamento concorrente, rimozione dati obsoleti', async () => {
  const { state, cache } = await cacheFixture();
  cache.upsertDisponibilita(availability(999));
  cache.upsertVeicolo({ id: 999 });
  state.disponibilita = Array.from({ length: 130 }, (_, i) => availability(i + 1));
  state.veicoli = [{ id: 1 }];
  await Promise.all([cache.loadCachesUltra(true), cache.loadCachesUltra(true), cache.loadCachesUltra()]);
  assert.equal(state.connects, 1);
  assert.equal(state.released, 1);
  assert.equal(cache.CacheStore.disponibilitaCache.size, 130);
  assert.equal(cache.CacheStore.veicoloToDisponibilita.has(999), false);
  assert.equal(cache.CacheStore.veicoliCache.has(999), false);
});

test('cache: duplicati storici non fanno prevalere il turno con ID inferiore', async () => {
  const { state, cache } = await cacheFixture();
  state.disponibilita = [availability(20, 1), availability(10, 1)];
  await cache.loadCachesUltra(true);
  assert.equal(cache.CacheStore.veicoloToDisponibilita.get(1).id, 20);
  await cache.removeDisponibilita(10);
  assert.equal(cache.CacheStore.veicoloToDisponibilita.get(1).id, 20);
});

test('cache: Redis fallito preserva lo snapshot e consente un nuovo tentativo', async () => {
  const { state, cache } = await cacheFixture();
  cache.upsertDisponibilita(availability(999));
  state.disponibilita = [availability(1)];
  state.failRedis = true;
  await assert.rejects(cache.loadCachesUltra(true), /redis offline/);
  assert.equal(cache.CacheStore.veicoloToDisponibilita.has(999), true);
  assert.equal(cache.CacheStore.veicoloToDisponibilita.has(1), false);
  assert.equal(cache.CacheStore.lastSync, 0);
  state.failRedis = false;
  await cache.loadCachesUltra(true);
  assert.equal(cache.CacheStore.veicoloToDisponibilita.has(1), true);
  assert.equal(state.released, 2);
});

test('cache: aggiornamento durante il caricamento viene riletto prima della pubblicazione', async () => {
  const { state, cache } = await cacheFixture();
  state.disponibilita = [availability(1)];
  state.onExec = () => {
    assert.equal(state.released, 1, 'La connessione DB viene rilasciata prima di attendere Redis');
    assert.equal(cache.CacheStore.disponibilitaCache.size, 0, 'Lo snapshot non e pubblicato prima di Redis');
    state.veicoli = [{ id: 8, marca: 'aggiornata' }];
    cache.upsertVeicolo(state.veicoli[0]);
  };
  await cache.loadCachesUltra(true);
  assert.equal(state.connects, 2);
  assert.equal(cache.CacheStore.veicoliCache.get(8).marca, 'aggiornata');
});

test('cache: preserva disponibile=false senza forzare il turno ad attivo', async () => {
  const { state, cache } = await cacheFixture();
  state.disponibilita = [{ ...availability(1), disponibile: false }];
  await cache.loadCachesUltra(true);
  assert.equal(cache.CacheStore.veicoloToDisponibilita.get(1).disponibile, false);
});
