import cron from 'node-cron';
import { pool } from '../db/db.js';
import { riconciliaBatchPopbus } from '../services/popbus/v2/reservation-reconciliation.service.js';

// Lock di sessione, conservato sul medesimo client per tutta l'esecuzione.
const LOCK_NAME = 'popbus-reconciliation-batch-v2';
let task = null;
let running = false;
let stopping = false;
let activeRun = null;

function assertAuthorized() {
  if (process.env.POPBUS_RECON_WORKER_ENABLED !== 'YES') {
    throw new Error('[POPBUS RECON] Worker non abilitato');
  }
  if (process.env.POPBUS_RECON_ENABLED !== 'YES' ||
      process.env.POPBUS_RECON_APPROVED !== 'YES') {
    throw new Error('[POPBUS RECON] Riconciliazione non autorizzata');
  }
  if (!(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_')) {
    throw new Error('[POPBUS RECON] Solo Stripe TEST consentito');
  }
}

export async function runPopbusReconciliationCycle() {
  if (stopping || running) return { outcome: 'busy_local' };
  assertAuthorized();
  running = true;
  const started = Date.now();
  const execution = (async () => {
    const client = await pool.connect();
    let acquired = false;
    try {
      const lock = await client.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1::text,0)) AS acquired',
        [LOCK_NAME]
      );
      if (!lock.rows[0]?.acquired) return { outcome: 'busy_global' };
      acquired = true;
      const result = await riconciliaBatchPopbus({ limit: 20, dryRun: false });
      const errors = result.results.filter(x => x.outcome === 'error');
      console.log('[POPBUS RECON] Ciclo:', JSON.stringify({
        scanned: result.scanned, errors: errors.length,
        durationMs: Date.now() - started, results: result.results
      }));
      if (errors.length) console.error('[POPBUS RECON] Errori nel batch:', errors);
      return { outcome: errors.length ? 'partial_error' : 'completed', ...result };
    } finally {
      try {
        if (acquired) {
          await client.query(
            'SELECT pg_advisory_unlock(hashtextextended($1::text,0)) AS released',
            [LOCK_NAME]
          );
        }
        client.release();
      } catch (error) {
        client.release(true);
        throw error;
      }
    }
  })();
  activeRun = execution;
  try {
    return await execution;
  } finally {
    activeRun = null;
    running = false;
  }
}

export function startPopbusReconciliationWorker() {
  if (task) {
    console.warn('[POPBUS RECON] Scheduler già avviato');
    return;
  }
  assertAuthorized();
  stopping = false;
  task = cron.schedule('* * * * *', async () => {
    try {
      await runPopbusReconciliationCycle();
    } catch (error) {
      console.error('[POPBUS RECON] Errore scheduler:', error?.stack || error);
    }
  }, { noOverlap: true });
  console.log('[POPBUS RECON] Scheduler avviato, frequenza 1 minuto');
}

export async function stopPopbusReconciliationWorker() {
  stopping = true;
  if (task) {
    task.stop();
    task.destroy();
    task = null;
  }
  if (activeRun) await activeRun;
  console.log('[POPBUS RECON] Scheduler arrestato');
}
