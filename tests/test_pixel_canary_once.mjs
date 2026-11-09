import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = pathToFileURL(`${process.cwd()}/`);
const require = createRequire(new URL('package.json', root));
const express = require('express');
const jwt = require('jsonwebtoken');
const { createPixelCanaryOnce } = await import(new URL('workers/pixel-canary-once.js', root));
const { createPixelWorkerControlRouter } = await import(new URL('routes/admin/pixel-worker.routes.js', root));
const { JWT_SECRET } = await import(new URL('config/security.js', root));
const approved = {
  POPBUS_PIXEL_CANARY_APPROVED: '1', POPBUS_PIXEL_FIRST_MODE: 'ROLLBACK_ONLY',
  POPBUS_PIXEL_FIRST_ENABLED: 'false', POPBUS_WORKER_ENABLED: 'false',
  PIXEL_FIRST_PIPELINE_ENABLED: '0', POPBUS_PIXEL_OBSERVATION_ONCE_ALLOWED: '0',
  POPBUS_PIXEL_FIRST_LIVE_APPROVED: '0', PIXEL_FIRST_PIPELINE_LIVE_APPROVED: '0',
  PIXEL_OPERATIONAL_LIVE_APPROVED: '0', POPBUS_PIXEL_CANARY_OPPORTUNITY_ID: '10',
  POPBUS_PIXEL_CANARY_VEHICLE_ID: '20', POPBUS_PIXEL_CANARY_OPERATOR_ID: '30'
};
const idle = () => ({ state: 'IDLE' });

test('rejects invalid scope, active workers, and full LIVE flags', () => {
  for (const [env, workerStatus, observationStatus, reason] of [
    [{ ...approved, POPBUS_PIXEL_CANARY_OPERATOR_ID: '1e2' }, idle, idle, /SCOPE_INVALID/],
    [{ ...approved, POPBUS_PIXEL_FIRST_LIVE_APPROVED: '1' }, idle, idle, /NOT_AUTHORIZED/],
    [approved, () => ({ running: true }), idle, /WORKER_ACTIVE/],
    [approved, idle, () => ({ state: 'RUNNING' }), /WORKER_ACTIVE/]
  ]) {
    const canary = createPixelCanaryOnce({ env, workerStatus, observationStatus,
      execute: () => assert.fail('Canary should not execute') });
    assert.throws(canary.start, reason);
    assert.equal(canary.status().state, 'IDLE');
  }
});

test('admin route accepts one empty request and keeps the scope fixed', async () => {
  let calls = 0;
  const canary = createPixelCanaryOnce({ env: approved, workerStatus: idle, observationStatus: idle,
    execute: async args => {
      calls++;
      assert.deepEqual(args, { mode: 'LIVE', canaryScope: { opportunityId: 10, vehicleId: 20, operatorId: 30 } });
      return { persistita: true, offerte: 1, attivazioneId: 40, offertaId: 50, internal: 'private' };
    } });
  const app = express();
  app.use(express.json(), createPixelWorkerControlRouter({ canary: canary.start, canaryStatus: canary.status }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const admin = jwt.sign({ role: 'admin' }, JWT_SECRET);
  const client = jwt.sign({ role: 'cliente' }, JWT_SECRET);
  const post = (token, payload = {}) => fetch(`${url}/canary-once`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload)
  });
  try {
    assert.equal((await post()).status, 401);
    assert.equal((await post(client)).status, 403);
    assert.equal((await post(admin, { vehicleId: 999 })).status, 400);
    assert.equal(calls, 0);
    const starts = await Promise.all([post(admin), post(admin)]);
    assert.deepEqual(starts.map(response => response.status).sort(), [202, 409]);
    await canary.settled();
    assert.equal(calls, 1);
    const response = await fetch(`${url}/canary`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.activationId, 40);
    assert.equal(result.offerId, 50);
    assert.ok(!('internal' in result));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
