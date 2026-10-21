// POPBUS 5E.2 - test isolato del worker reale (nessuna connessione esterna)
// Salvare come tests/popbus-reconciliation-5e.mjs
// Eseguire: node --experimental-vm-modules tests/popbus-reconciliation-5e.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../workers/popbus-reconciliation.worker.js', import.meta.url), 'utf8');
const log = (s) => console.log(`[POPBUS 5E] ${s}`);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function harness(options = {}) {
  const events = { queries: [], releases: [], schedules: [], batches: 0, stops: 0, destroys: 0, logs: [] };
  const env = {
    POPBUS_RECON_WORKER_ENABLED: 'YES', POPBUS_RECON_ENABLED: 'YES',
    POPBUS_RECON_APPROVED: 'YES', STRIPE_SECRET_KEY: 'sk_test_mock_NOT_REAL',
    ...options.env,
  };
  const client = {
    async query(sql, params) {
      events.queries.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: options.lock !== false }] };
      if (sql.includes('pg_advisory_unlock')) {
        if (options.unlockError) throw new Error('simulated unlock failure');
        return { rows: [{ released: options.unlockReleased !== false }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release(destroy) {
      events.releases.push(destroy === true);
      if (options.releaseError && events.releases.length === 1) throw new Error('simulated release failure');
    },
  };
  const pool = { async connect() {
    if (options.connectError) throw new Error('simulated connect failure');
    return client;
  } };
  const cron = { schedule(expr, callback, config) {
    const t = {
      expr, callback, config,
      stop() { events.stops++; },
      destroy() { events.destroys++; },
    };
    events.schedules.push(t);
    return t;
  } };
  const batch = async (args) => {
    events.batches++;
    assert.equal(args.limit, 20);
    assert.equal(args.dryRun, false);
    if (options.batch) return options.batch();
    return { scanned: 1, results: [{ outcome: 'canceled' }] };
  };
  const ctx = vm.createContext({
    process: { env }, Date, JSON,
    console: {
      log: (...x) => events.logs.push(['log', ...x]),
      error: (...x) => events.logs.push(['error', ...x]),
      warn: (...x) => events.logs.push(['warn', ...x]),
    },
  });
  const module = new vm.SourceTextModule(source, { context: ctx, identifier: 'popbus-reconciliation.worker.js' });
  const dependencies = {
    'node-cron': { default: cron },
    '../db/db.js': { pool },
    '../services/popbus/v2/reservation-reconciliation.service.js': { riconciliaBatchPopbus: batch },
  };
  await module.link(async (specifier) => {
    const exports = dependencies[specifier];
    assert.ok(exports, `Import non previsto: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context: ctx, identifier: specifier });
  });
  await module.evaluate();
  return { api: module.namespace, events, env };
}

async function check(name, fn) {
  try { await fn(); log(`PASS ${name}`); }
  catch (error) { log(`FAIL ${name}: ${error.stack || error}`); process.exitCode = 1; }
}

await check('5E-A: avvio negato senza autorizzazioni', async () => {
  for (const patch of [
    { POPBUS_RECON_WORKER_ENABLED: 'NO' },
    { POPBUS_RECON_ENABLED: 'NO' },
    { POPBUS_RECON_APPROVED: 'NO' },
    { STRIPE_SECRET_KEY: 'sk_live_fake' },
  ]) {
    const { api, events } = await harness({ env: patch });
    assert.throws(() => api.startPopbusReconciliationWorker());
    assert.equal(events.schedules.length, 0);
    assert.equal(events.batches, 0);
  }
});

await check('5E-B: lock globale occupato', async () => {
  const { api, events } = await harness({ lock: false });
  const result = await api.runPopbusReconciliationCycle();
  assert.equal(result.outcome, 'busy_global');
  assert.equal(events.batches, 0);
  assert.deepEqual(events.releases, [false]);
  assert.equal(events.queries.filter(x => x.sql.includes('pg_advisory_unlock')).length, 0);
});

await check('5E-C: due cicli concorrenti e avvio cron singolo', async () => {
  const pending = deferred();
  const { api, events } = await harness({ batch: () => pending.promise });
  api.startPopbusReconciliationWorker();
  api.startPopbusReconciliationWorker();
  assert.equal(events.schedules.length, 1);
  assert.equal(events.schedules[0].expr, '* * * * *');
  assert.equal(events.schedules[0].config.noOverlap, true);
  const first = api.runPopbusReconciliationCycle();
  const second = await api.runPopbusReconciliationCycle();
  assert.equal(second.outcome, 'busy_local');
  pending.resolve({ scanned: 1, results: [] });
  assert.equal((await first).outcome, 'completed');
  assert.equal(events.batches, 1);
  assert.equal(events.queries.filter(x => x.sql.includes('pg_advisory_unlock')).length, 1);
  assert.deepEqual(events.releases, [false]);
  await api.stopPopbusReconciliationWorker();
  assert.equal(events.stops, 1);
  assert.equal(events.destroys, 1);
});

await check('5E-D: errori nel batch riportati come partial_error', async () => {
  const { api, events } = await harness({ batch: async () => ({
    scanned: 2, results: [{ outcome: 'canceled' }, { outcome: 'error', message: 'simulated' }],
  }) });
  const result = await api.runPopbusReconciliationCycle();
  assert.equal(result.outcome, 'partial_error');
  assert.equal(events.logs.some(x => x[0] === 'error' && String(x[1]).includes('Errori nel batch')), true);
  assert.deepEqual(events.releases, [false]);
});

await check('5E-E: eccezione batch rilascia lock e client', async () => {
  const { api, events } = await harness({ batch: async () => { throw new Error('simulated batch failure'); } });
  await assert.rejects(api.runPopbusReconciliationCycle(), /simulated batch failure/);
  assert.equal(events.queries.filter(x => x.sql.includes('pg_advisory_unlock')).length, 1);
  assert.deepEqual(events.releases, [false]);
  assert.equal((await api.runPopbusReconciliationCycle().catch(e => e.message)), 'simulated batch failure');
});

await check('5E-F: arresto attende il ciclo e impedisce nuovi avvii', async () => {
  const pending = deferred();
  const { api, events } = await harness({ batch: () => pending.promise });
  api.startPopbusReconciliationWorker();
  const run = api.runPopbusReconciliationCycle();
  let stopped = false;
  const stop = api.stopPopbusReconciliationWorker().then(() => { stopped = true; });
  assert.equal((await api.runPopbusReconciliationCycle()).outcome, 'busy_local');
  assert.equal(stopped, false);
  pending.resolve({ scanned: 0, results: [] });
  await run;
  await stop;
  assert.equal(stopped, true);
  assert.equal(events.stops, 1);
  assert.equal(events.destroys, 1);
  assert.deepEqual(events.releases, [false]);
});

await check('5E-G: unlock fallito non perde client', async () => {
  const { api, events } = await harness({ unlockError: true });
  await assert.rejects(api.runPopbusReconciliationCycle(), /simulated unlock failure/);
  assert.deepEqual(events.releases, [true]);
});

// Diagnostiche aggiuntive: non cambiano il risultato dei sette test contrattuali.
// Evidenziano problemi reali da correggere prima di attivare lo scheduler.
for (const [name, opts, run] of [
  ['5E-H: advisory_unlock restituisce false', { unlockReleased: false }, async ({ api, events }) => {
    const result = await api.runPopbusReconciliationCycle();
    return { outcome: result.outcome, unlockReturnedFalse: true, clientReleased: events.releases.length };
  }],
  ['5E-I: release lancia eccezione', { releaseError: true }, async ({ api, events }) => {
    try { await api.runPopbusReconciliationCycle(); return { unexpected: 'no error' }; }
    catch (e) { return { error: e.message, releaseCalls: events.releases.length }; }
  }],
  ['5E-J: stop durante batch che fallisce', { batch: async () => { throw new Error('simulated batch failure'); } }, async ({ api, events }) => {
    api.startPopbusReconciliationWorker();
    const run = api.runPopbusReconciliationCycle();
    const stop = api.stopPopbusReconciliationWorker();
    const results = await Promise.allSettled([run, stop]);
    return { run: results[0].status, stop: results[1].status, logs: events.logs.filter(x => String(x[1]).includes('Scheduler arrestato')).length };
  }],
]) {
  try {
    const h = await harness(opts);
    const result = await run(h);
    log(`DIAGNOSTICA ${name}: ${JSON.stringify(result)}`);
  } catch (e) { log(`DIAGNOSTICA ${name}: ${e.message}`); }
}

if (process.exitCode) log('TEST 5E.2: UNO O PIU SCENARI FALLITI');
else log('PASS 5E.2: sette scenari superati; leggere anche le diagnostiche H/I/J');
