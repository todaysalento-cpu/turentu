// TURENTU — audit statico dei contratti PIXEL-first, sola lettura.
// Eseguire dalla root del progetto: node tests/test_pixel_first_contratti_readonly.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const files = {
  model: 'services/popbus/v2/model.js',
  adapter: 'services/popbus/v2/pixel-opportunity-adapter.js',
  source: 'services/popbus/v2/pixel-worker-formation-source.js',
  worker: 'services/popbus/v2/worker.js',
  persistence: 'services/popbus/v2/popbus-cycle-persistence.js',
  acceptance: 'services/popbus/v2/acceptance.js',
};
const code = {};
for (const [name, relative] of Object.entries(files)) {
  const file = path.join(root, relative);
  assert.ok(fs.existsSync(file), `FILE_ASSENTE: ${relative}; verificare percorso`);
  code[name] = fs.readFileSync(file, 'utf8');
}
const checks = {
  tempoAlNodoSalita: /date\s*-\s*times\[s\]/.test(code.model),
  intersezioneFinestre: /Math\.max\(lower,\s*x\.lower\)/.test(code.model) && /Math\.min\(upper,\s*x\.upper\)/.test(code.model),
  adapterSolaLettura: !/\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(code.adapter),
  provenienzaPixel: /pixelOpportunitaId/.test(code.source) && /pixelVersione/.test(code.source),
  preflightPixelPersistenza: /verificaOpportunitaPixel/.test(code.persistence),
  preflightPixelAcceptance: /verificaAccettazionePixel/.test(code.acceptance),
  workerFailClosed: /POPBUS_PIXEL_FIRST_NON_ABILITATO/.test(code.worker),
  acceptanceRichiedeSnapshot: /requestSnapshot/.test(code.acceptance),
  acceptanceRichiedeCoordinate: /plan\.coordinates/.test(code.acceptance),
  acceptanceRichiedeMissioni: /verificaMissioniPersistite/.test(code.acceptance),
};
const passed = Object.values(checks).every(Boolean);
console.log('PIXEL_FIRST_CONTRATTI_JSON:' + JSON.stringify({ passed, checks, note: 'Audit statico: non certifica il percorso transazionale, concorrenza, idempotenza o acceptance E2E.' }));
if (!passed) process.exitCode = 1;
