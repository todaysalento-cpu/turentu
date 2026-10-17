// TURENTU NCC - PRE-FLIGHT INFRASTRUTTURA SU RENDER
// GET /api/admin/diagnostica-ncc-infrastruttura
// Richiede x-diagnostic-token; non scrive su DB/Redis/Stripe.
// Rimuovere la route dopo il collaudo.
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import { pool } from '../db/db.js';
import { redisClient } from '../redis.js';

const router = Router();
const TIMEOUT_MS = 8000;
function authorized(req) {
  const expected = process.env.DIAGNOSTIC_TOKEN;
  const received = req.get('x-diagnostic-token');
  if (!expected || !received || expected.length < 24) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function withTimeout(promise, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name}: timeout ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}
function safeError(err) {
  // Non restituire messaggi grezzi: potrebbero contenere URL, host o credenziali.
  return err?.code && /^[A-Z0-9_]+$/.test(err.code) ? err.code : 'CONTROLLO_FALLITO';
}
router.get('/diagnostica-ncc-infrastruttura', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!process.env.DIAGNOSTIC_TOKEN || process.env.DIAGNOSTIC_TOKEN.length < 24) {
    return res.status(404).json({ ok: false, error: 'Non disponibile' });
  }
  if (!authorized(req)) return res.status(403).json({ ok: false, error: 'Non autorizzato' });

  const checks = {};
  try {
    if (!redisClient) throw new Error('Redis non configurato');
    if (!redisClient.isReady) throw new Error('Redis non pronto');
    const pong = await withTimeout(redisClient.ping(), 'Redis');
    checks.redis = { ok: pong === 'PONG', ready: redisClient.isReady };
  } catch (err) {
    checks.redis = { ok: false, ready: Boolean(redisClient?.isReady), error: safeError(err) };
  }

  try {
    const result = await withTimeout(pool.query('SELECT 1 AS ok'), 'PostgreSQL');
    checks.postgresql = { ok: Number(result.rows[0]?.ok) === 1 };
  } catch (err) {
    checks.postgresql = { ok: false, error: safeError(err) };
  }

  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key.startsWith('sk_test_')) {
    checks.stripe = { ok: false, test_mode: false, error: 'CHIAVE_TEST_ASSENTE' };
  } else {
    try {
      const stripe = new Stripe(key, { timeout: TIMEOUT_MS, maxNetworkRetries: 0 });
      const account = await withTimeout(stripe.accounts.retrieve(), 'Stripe');
      checks.stripe = { ok: Boolean(account?.id), test_mode: true };
    } catch (err) {
      checks.stripe = { ok: false, test_mode: true, error: safeError(err) };
    }
  }

  const ok = Object.values(checks).every(x => x.ok);
  console.log('[NCC INFRA PREFLIGHT]', { ok, redis: checks.redis.ok, postgresql: checks.postgresql.ok, stripe: checks.stripe.ok });
  return res.status(ok ? 200 : 503).json({ ok, mode: 'READ_ONLY', checks });
});
export default router;
