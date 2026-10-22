// Destinazione: tests/test-pixel-territorial-runner.js
// Test minimo isolato: nessun DB reale, nessuna chiamata Google.
import assert from 'node:assert/strict';
import { parsePixelTerritorialConfig, runPixelTerritorialCycle } from '../services/pixel/pixel-territorial-runner.service.js';

const off = parsePixelTerritorialConfig({});
assert.equal(off.mode, 'OFF');
assert.throws(() => parsePixelTerritorialConfig({ PIXEL_TERRITORIAL_MODE: 'ACTIVE' }));
const config = parsePixelTerritorialConfig({ PIXEL_TERRITORIAL_MODE: 'SHADOW', PIXEL_TERRITORIAL_COMUNI: '075088,075088,075039' });
assert.deepEqual(config.comuni, ['075088', '075039']);
assert.equal(config.intervalMs, 86400000);

const events = [];
const client = {
  async query(sql) {
    events.push(sql.includes('pg_try_advisory_lock') ? 'lock' : 'unlock');
    return { rows: [{ acquired: true }] };
  },
  release() { events.push('release'); },
};
const db = { async connect() { return client; } };
const visited = [];
const summary = await runPixelTerritorialCycle(config, {
  database: db,
  diagnostic: async comune => { visited.push(comune); return { stato: 'ok', nodi: 1, candidati_distinti: 3, selezionati_comunali: 2, errori: [] }; },
  logger: { info() {}, error() {} },
});
assert.deepEqual(visited, ['075088', '075039']);
assert.equal(summary.eseguiti, 2);
assert.equal(summary.scritture, 0);
assert.deepEqual(events, ['lock','unlock','release','lock','unlock','release']);
console.log('OK: runner PIXEL SHADOW, configurazione, lock e zero scritture.');
