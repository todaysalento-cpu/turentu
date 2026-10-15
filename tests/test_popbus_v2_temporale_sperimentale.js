// POPBUS V2 - TEST GENERATORE TEMPORALE SPERIMENTALE (SOLO CPU)
// Salva questo file e il modulo sperimentale nella cartella indicata.
// node tests\test_popbus_v2_temporale_sperimentale.js
import assert from 'node:assert/strict';
import { diagnosticaCandidateTemporali } from '../services/popbus/v2/temporal-experiment.js';

const BASE = Date.parse('2027-04-01T10:00:00Z');
const MIN = 60000;
const scenario = (n, shift) => Array.from({ length: n }, (_, i) => ({
  id: i + 1, start_node_id: i + 1, end_node_id: i + 2,
  start_datetime: new Date(BASE + i * 10 * MIN + shift(i) * MIN).toISOString(),
  posti_richiesti: 1, prezzo: 30, classe: 'STANDARD'
}));
let failures = 0;
for (const [name, shift] of [
  ['allineate', () => 0],
  ['alternate_2h', i => i % 2 ? 120 : 0],
  ['progressive_2h', i => i * 120]
]) {
  const req = scenario(30, shift);
  const result = await diagnosticaCandidateTemporali(req, {
    roadSeconds: async () => 600
  });
  const { stats } = result;
  console.log(name, stats);
  try {
    assert.equal(stats.total, 465);
    assert.equal(stats.routingCalls, 30);
    assert.equal(stats.indeterminate, 0);
    assert.equal(stats.productionPruned, 0);
    assert.equal(stats.seedIncompatible, name === 'allineate' ? 0 : 435);
    assert.equal(stats.seedCompatible, name === 'allineate' ? 465 : 30);
    assert.ok(result.details.every(x => x.safeToPruneWholeCandidate === false));
    console.log('PASS', name);
  } catch (e) { failures++; console.error('FAIL', name, e.message); }
}
{
  const req = scenario(3, () => 0);
  const result = await diagnosticaCandidateTemporali(req, {
    roadSeconds: async () => { throw new Error('routing non disponibile'); }
  });
  try {
    assert.equal(result.stats.total, 6);
    assert.equal(result.stats.indeterminate, 6);
    assert.equal(result.stats.seedIncompatible, 0);
    console.log('PASS routing non disponibile: nessuno scarto');
  } catch (e) { failures++; console.error('FAIL fallback routing', e.message); }
}
console.log(failures ? `ESITO: ${failures} anomalie` : 'ESITO: 4/4 PASS');
if (failures) process.exitCode = 1;
