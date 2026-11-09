import { AsyncLocalStorage } from 'node:async_hooks';

const cycleBudget = new AsyncLocalStorage();

export function readPixelLiveRoutingLimit(env = process.env) {
  const value = env.POPBUS_PIXEL_LIVE_ROUTING_LIMIT ?? '';
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 500) {
    throw new Error('POPBUS_PIXEL_LIVE_ROUTING_LIMIT deve essere un intero da 1 a 500');
  }
  return Number(value);
}

export async function withPixelRoutingBudget(limit, run) {
  const budget = { limit, used: 0, exhausted: false };
  return cycleBudget.run(budget, async () => {
    const result = await run();
    assertPixelRoutingBudget();
    return { ...result, routingRequests: budget.used, routingLimit: limit };
  });
}

export function assertPixelRoutingBudget() {
  if (cycleBudget.getStore()?.exhausted) {
    throw new Error('PIXEL_LIVE_ROUTING_BUDGET_EXHAUSTED');
  }
}

export function reservePixelRoutingRequest() {
  const budget = cycleBudget.getStore();
  if (!budget) return;
  if (budget.used >= budget.limit) budget.exhausted = true;
  assertPixelRoutingBudget();
  budget.used++;
}
