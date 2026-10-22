// Test minimo con DB simulato: nessuna chiamata Google e nessuna scrittura reale.
import assert from 'node:assert/strict';
import { parsePixelTerritorialConfig, runPixelTerritorialCycle } from '../services/pixel/pixel-territorial-runner.service.js';

const config = parsePixelTerritorialConfig({
  PIXEL_TERRITORIAL_MODE: 'SHADOW',
  PIXEL_TERRITORIAL_COMUNI: 'AUTO',
  PIXEL_TERRITORIAL_INTERVAL_HOURS: '24',
});
assert.equal(config.auto, true);
const runs = new Map();
let calls = 0;
const client = {
  async query(sql, params = []) {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
    if (sql.includes('SELECT prossimo_tentativo')) return {
      rows: runs.has(params[0]) ? [{ prossimo_tentativo: runs.get(params[0]) }] : [],
    };
    if (sql.includes('INSERT INTO public.pixel_territorial_runs')) {
      runs.set(params[0], params[2]);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Query inattesa: ${sql}`);
  },
  release() {},
};
const database = {
  async query(sql) {
    assert.match(sql, /pixel_budget_comunali/);
    return { rows: [{ codice_istat_comune: '075088' }] };
  },
  async connect() { return client; },
};
const logger = { info() {}, error(...args) { throw new Error(JSON.stringify(args)); } };
const diagnostic = async () => {
  calls++;
  return { stato: 'ok', nodi: 2, candidati_distinti: 21,
    selezionati_comunali: 8, errori: [] };
};
const now = () => new Date('2026-10-22T08:00:00.000Z');
const first = await runPixelTerritorialCycle(config, { database, diagnostic, logger, now });
assert.equal(first.eseguiti, 1);
assert.equal(first.scritture_audit, 1);
assert.equal(first.scritture_fermate, 0);
const second = await runPixelTerritorialCycle(config, { database, diagnostic, logger, now });
assert.equal(second.eseguiti, 0);
assert.equal(second.saltati, 1);
assert.equal(calls, 1);
const third = await runPixelTerritorialCycle(config, {
  database, diagnostic, logger, now: () => new Date('2026-10-23T08:00:01.000Z'),
});
assert.equal(third.eseguiti, 1);
assert.equal(calls, 2);
const off = await runPixelTerritorialCycle({ ...config, mode: 'OFF' }, { database, diagnostic, logger });
assert.equal(off.eseguiti, 0);
console.log('OK: AUTO, audit persistente simulato, cooldown, OFF e zero scritture fermate.');
