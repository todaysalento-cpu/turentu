import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = pathToFileURL(`${process.cwd()}/`);
const scope = { opportunityId: 10, vehicleId: 20, operatorId: 30 };
const cycle = { vehicleId: 20, missioni: [{ pixelOpportunitaId: 10 }] };
const forbid = () => assert.fail('Unexpected database access');
const { validateCanaryScope, assertCanaryCycle } = await import(
  new URL('services/popbus/v2/popbus-canary-scope.js', root));
const { persistiCicloFisicoLiveInTransazioneV2 } = await import(
  new URL('services/popbus/v2/popbus-physical-writer-v2.js', root));
const { processaPixelFirstMultimissione } = await import(
  new URL('services/popbus/v2/pixel-first-multimission-service.js', root));

test('scope is immutable and requires three positive integer IDs', () => {
  const validated = validateCanaryScope(scope);
  assert.deepEqual(validated, scope);
  assert.ok(Object.isFrozen(validated));
  for (const invalid of [null, {}, { ...scope, vehicleId: '20' }, { ...scope, operatorId: 0 }]) {
    assert.throws(() => validateCanaryScope(invalid), /SCOPE_INVALID/);
  }
});

test('cycle and revalidated operator must match the scope', () => {
  assert.doesNotThrow(() => assertCanaryCycle(scope, cycle, 30));
  assert.throws(() => assertCanaryCycle(scope, cycle, 31), /OUT_OF_SCOPE/);
  assert.throws(() => assertCanaryCycle(scope, { ...cycle, vehicleId: 21 }), /OUT_OF_SCOPE/);
  assert.throws(() => assertCanaryCycle(scope, { ...cycle, missioni: [...cycle.missioni, ...cycle.missioni] }), /OUT_OF_SCOPE/);
});

test('writer rejects a different opportunity before querying', async () => {
  await assert.rejects(persistiCicloFisicoLiveInTransazioneV2({ client: { query: forbid },
    ciclo: { ...cycle, missioni: [{ pixelOpportunitaId: 11 }] }, canaryScope: scope }), /OUT_OF_SCOPE/);
});

test('unapproved canary cannot open a database connection', async () => {
  const previous = process.env.POPBUS_PIXEL_CANARY_APPROVED;
  process.env.POPBUS_PIXEL_CANARY_APPROVED = '0';
  try {
    await assert.rejects(processaPixelFirstMultimissione({ pool: { connect: forbid },
      mode: 'LIVE', canaryScope: scope }), /canary non autorizzato/);
  } finally {
    if (previous === undefined) delete process.env.POPBUS_PIXEL_CANARY_APPROVED;
    else process.env.POPBUS_PIXEL_CANARY_APPROVED = previous;
  }
});
