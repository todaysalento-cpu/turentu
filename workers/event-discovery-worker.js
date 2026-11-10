import 'dotenv/config';
import { automaticPublisher, createDiscovery, enabled } from '../services/event-discovery/service.js';

if (enabled() && (enabled('SEARCH') || enabled('MONITOR') || automaticPublisher())) {
  const { pool } = await import('../db/db.js');
  const discovery = createDiscovery(pool);
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });

  async function execute(action) {
    try { await action(); }
    catch (error) {
      if (error.status !== 409) {
        console.error(JSON.stringify({ component: 'event-discovery-worker', status: error.status || 500 }));
        process.exitCode = 1;
      }
    }
  }

  try {
    if (enabled('MONITOR')) {
      const { rows } = await pool.query(`SELECT id FROM public.event_discovery_sources WHERE state='attiva'
        AND (last_sync IS NULL OR last_sync + interval_minutes * interval '1 minute' <= now())
        ORDER BY last_sync NULLS FIRST, id LIMIT 10`);
      for (const source of rows) {
        if (stopping) break;
        await execute(() => discovery.sync(source.id, null));
      }
    }
    if (!stopping && enabled('SEARCH') && enabled('BRAVE_STORAGE_AUTHORIZED') && process.env.EVENT_DISCOVERY_BRAVE_KEY) {
      await execute(() => discovery.discover({}, null));
    }
    if (!stopping && automaticPublisher()) await execute(() => discovery.publishApproved(() => stopping));
  } finally {
    await pool.end();
  }
}
