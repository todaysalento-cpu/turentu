const MINUTE_MS = 60_000;
const WINDOW_MINUTES = 60;
const GROUPS = new Set(['search', 'booking', 'popbus', 'pixel', 'pagamenti', 'wallet', 'auth', 'chat']);

export function createApiMetrics({ now = Date.now, clock = () => performance.now() } = {}) {
  const startedAt = now();
  const buckets = Array(WINDOW_MINUTES + 1);

  function observe(req, res, next) {
    const path = req.path;
    if ((!path.startsWith('/api/') && path !== '/webhook-stripe') ||
        path === '/api/admin' || path.startsWith('/api/admin/')) {
      return next();
    }

    const prefix = path.split('/', 4)[2];
    const group = path === '/webhook-stripe' ? 'stripe_webhook' : GROUPS.has(prefix) ? prefix : 'altre_api';
    const start = clock();
    res.once('finish', () => {
      const minute = Math.floor(now() / MINUTE_MS);
      const index = minute % buckets.length;
      if (buckets[index]?.minute !== minute) buckets[index] = { minute, groups: {} };
      const groups = buckets[index].groups;
      const stats = groups[group] ??= { requests: 0, errors5xx: 0, totalMs: 0 };
      stats.requests++;
      stats.errors5xx += Number(res.statusCode >= 500);
      stats.totalMs += clock() - start;
    });
    next();
  }

  function snapshot() {
    const end = now();
    const from = Math.max(startedAt, end - WINDOW_MINUTES * MINUTE_MS);
    const firstMinute = Math.max(Math.floor(startedAt / MINUTE_MS), Math.ceil((end - WINDOW_MINUTES * MINUTE_MS) / MINUTE_MS));
    const lastMinute = Math.floor(end / MINUTE_MS);
    const groups = {};
    const series = [];
    for (let minute = firstMinute; minute <= lastMinute; minute++) {
      const bucket = buckets[minute % buckets.length];
      const point = { at: minute * MINUTE_MS, requests: 0, errors5xx: 0 };
      if (bucket?.minute === minute) {
        for (const [group, stats] of Object.entries(bucket.groups)) {
          const total = groups[group] ??= { requests: 0, errors5xx: 0, totalMs: 0 };
          total.requests += stats.requests;
          total.errors5xx += stats.errors5xx;
          total.totalMs += stats.totalMs;
          point.requests += stats.requests;
          point.errors5xx += stats.errors5xx;
        }
      }
      series.push(point);
    }
    return {
      scope: 'PROCESS_LOCAL',
      from: Math.max(from, firstMinute * MINUTE_MS),
      to: end,
      series,
      groups: Object.entries(groups).map(([group, { requests, errors5xx, totalMs }]) => ({
        group, requests, errors5xx, meanMs: Math.round(totalMs / requests),
      })),
    };
  }

  return { observe, snapshot };
}

export const apiMetrics = process.env.APP_MONITORING_HTTP === '1' ? createApiMetrics() : null;
