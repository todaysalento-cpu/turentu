import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = pathToFileURL(`${process.cwd()}/`);
const { getRouteGeometry } = await import(new URL('utils/maps.util.js', root));
const { withPixelRoutingBudget, assertPixelRoutingBudget } = await import(new URL('utils/pixel-routing-budget.js', root));
const from = { lat: 40, lon: 18 };
const to = { lat: 40.01, lon: 18.01 };

test('parallel calls cannot exceed the cycle budget and a swallowed error still blocks the cycle', async () => {
  let fetched = 0;
  const fetchImpl = async () => {
    fetched++;
    return { ok: true, json: async () => ({ status: 'OK', routes: [{ overview_polyline: { points: 'fixture' },
      legs: [{ distance: { value: 1000 }, duration: { value: 120 } }] }] }) };
  };
  const route = () => getRouteGeometry(from, to, { fetchImpl, apiKey: 'fixture' });
  await assert.rejects(withPixelRoutingBudget(2, async () => {
    const results = await Promise.allSettled([route(), route(), route(), route()]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 2);
    assert.throws(assertPixelRoutingBudget, /BUDGET_EXHAUSTED/);
    return {};
  }), /BUDGET_EXHAUSTED/);
  assert.equal(fetched, 2);
  const next = await withPixelRoutingBudget(1, async () => { await route(); return {}; });
  assert.equal(next.routingRequests, 1);
  await route();
  assert.equal(fetched, 4);
});
