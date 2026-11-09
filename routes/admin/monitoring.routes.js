import express from 'express';
import { readAppVersionPolicy } from '../../services/monitoring/version-policy.js';

export function createMonitoringRouter({ workerStatus, readPayments, apiMetrics }) {
  const router = express.Router();

  router.get('/overview', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const payments = await readPayments();
      const { scheduled, running, stopping, last } = workerStatus();
      res.json({
        updatedAt: new Date().toISOString(),
        api: apiMetrics?.snapshot() ?? null,
        worker: {
          scope: 'PROCESS_LOCAL',
          scheduled,
          running,
          stopping,
          last: last ? { ok: last.ok, durationMs: last.durationMs, finishedAt: last.finishedAt } : null,
        },
        payments,
        versions: readAppVersionPolicy(),
      });
    } catch {
      res.status(503).json({ error: 'Monitoraggio temporaneamente indisponibile' });
    }
  });

  return router;
}
