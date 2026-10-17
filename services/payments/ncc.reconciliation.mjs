// TURENTU NCC — reconciliation worker V2 (TEST PILOT)
// Save as services/payments/ncc.reconciliation.mjs
// Default READ ONLY. APPLY only with NCC_RECONCILE_APPLY=YES_TEST_ONLY.
// No Stripe capture, no ride status updates, no schema changes.
import Stripe from 'stripe';
import { pool } from '../../db/db.js';

const secret = process.env.STRIPE_SECRET_KEY || '';
if (!secret.startsWith('sk_test_')) {
  console.error('STOP: Stripe TEST key required');
  process.exit(2);
}
const apply = process.env.NCC_RECONCILE_APPLY === 'YES_TEST_ONLY';
const stripe = new Stripe(secret, { timeout: 10000, maxNetworkRetries: 1 });
const LOCK_KEY_1 = 849120; // namespace NCC reconciliation pilot
const LOCK_KEY_2 = 20261017;
const totals = { scanned: 0, matched: 0, repaired: 0, pending: 0, alerts: 0, skipped: 0 };
const log = (event, fields={}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
const alert = (id, reason) => { totals.alerts++; log('ALERT', { payment_id: id, reason }); };
function cents(value) {
  if (value == null || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) return null;
  const [whole, frac=''] = String(value).split('.');
  const result = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(result) ? result : null;
}
function stripeCheck(pi, expected) {
  if (pi.livemode || pi.currency !== 'eur') return 'mode/currency mismatch';
  if (pi.status === 'requires_capture') return 'pending';
  if (pi.status !== 'succeeded' || Number(pi.amount_received) !== expected)
    return `Stripe ${pi.status}, received=${pi.amount_received}, expected=${expected}`;
  return 'matched';
}
async function rideSnapshot(db, rideId, fixedPrice) {
  const { rows } = await db.query(`
    SELECT pr.id, pr.prezzo_totale, COUNT(g.id)::int AS payment_count
    FROM public.prenotazioni pr
    LEFT JOIN public.pagamenti g
      ON g.prenotazione_id=pr.id AND g.corsa_id=pr.corsa_id
    WHERE pr.corsa_id=$1
    GROUP BY pr.id,pr.prezzo_totale`, [rideId]);
  const sum = rows.reduce((n, r) => n + (cents(r.prezzo_totale) ?? NaN), 0);
  return rows.length > 0 && rows.every(r => r.payment_count === 1)
    && sum === cents(fixedPrice);
}
let client;
let locked = false;
try {
  console.log(`=== NCC RECONCILIATION V2: ${apply ? 'APPLY TEST' : 'READ ONLY'} ===`);
  client = await pool.connect();
  await client.query("SET statement_timeout = '15000ms'");
  await client.query("SET lock_timeout = '3000ms'");
  const lk = await client.query('SELECT pg_try_advisory_lock($1,$2) AS acquired', [LOCK_KEY_1, LOCK_KEY_2]);
  locked = lk.rows[0]?.acquired === true;
  if (!locked) {
    log('SKIP', { reason: 'another reconciliation worker is running' });
  } else {
    const { rows } = await client.query(`
      SELECT g.id AS payment_id, g.corsa_id, g.prenotazione_id,
             g.stripe_payment_intent AS pi_id, pr.prezzo_totale AS quota,
             c.prezzo_fisso
      FROM public.pagamenti g
      JOIN public.prenotazioni pr ON pr.id=g.prenotazione_id AND pr.corsa_id=g.corsa_id
      JOIN public.corse c ON c.id=g.corsa_id
      WHERE c.origine_address LIKE 'TURENTU_NCC_STRIPE_TEST_%'
        AND c.tipo_corsa='condivisa' AND c.prezzo_fisso IS NOT NULL
        AND g.stato='autorizzazione'
        AND g.stripe_payment_intent LIKE 'pi_%'
      ORDER BY g.id LIMIT 100`);
    log('CANDIDATES', { count: rows.length });
    for (const item of rows) {
      totals.scanned++;
      const expected = cents(item.quota);
      if (expected == null || expected <= 0) { alert(item.payment_id, 'invalid quota'); continue; }
      let pi;
      try { pi = await stripe.paymentIntents.retrieve(item.pi_id); }
      catch (e) { alert(item.payment_id, `Stripe retrieve: ${e.code || e.type || e.message}`); continue; }
      const check = stripeCheck(pi, expected);
      if (check === 'pending') { totals.pending++; log('PENDING', { payment_id: item.payment_id }); continue; }
      if (check !== 'matched') { alert(item.payment_id, check); continue; }
      if (!await rideSnapshot(client, item.corsa_id, item.prezzo_fisso)) {
        alert(item.payment_id, 'ride snapshot invalid'); continue;
      }
      totals.matched++;
      if (!apply) { log('MATCH', { payment_id: item.payment_id, would_mark_paid_cents: expected }); continue; }
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '15000ms'");
        await client.query("SET LOCAL lock_timeout = '3000ms'");
        // Serialize with code paths that lock the ride on completion.
        const cr = await client.query(`
          SELECT id, prezzo_fisso FROM public.corse
          WHERE id=$1 AND origine_address LIKE 'TURENTU_NCC_STRIPE_TEST_%'
            AND tipo_corsa='condivisa' AND prezzo_fisso IS NOT NULL
          FOR UPDATE`, [item.corsa_id]);
        if (!cr.rows.length) throw new Error('ride changed or no longer eligible');
        const gr = await client.query(`
          SELECT g.id, g.stato, g.stripe_payment_intent, pr.prezzo_totale
          FROM public.pagamenti g
          JOIN public.prenotazioni pr ON pr.id=g.prenotazione_id AND pr.corsa_id=g.corsa_id
          WHERE g.id=$1 AND g.corsa_id=$2 AND g.prenotazione_id=$3
          FOR UPDATE OF g, pr`, [item.payment_id, item.corsa_id, item.prenotazione_id]);
        if (!gr.rows.length || gr.rows[0].stato !== 'autorizzazione'
            || gr.rows[0].stripe_payment_intent !== item.pi_id
            || cents(gr.rows[0].prezzo_totale) !== expected) {
          await client.query('ROLLBACK');
          totals.skipped++;
          log('SKIP', { payment_id: item.payment_id, reason: 'payment changed concurrently' });
          continue;
        }
        if (!await rideSnapshot(client, item.corsa_id, cr.rows[0].prezzo_fisso))
          throw new Error('ride snapshot changed');
        // Refresh Stripe immediately before DB update. No Stripe capture occurs.
        const fresh = await stripe.paymentIntents.retrieve(item.pi_id);
        const freshCheck = stripeCheck(fresh, expected);
        if (freshCheck !== 'matched') throw new Error(`Stripe recheck: ${freshCheck}`);
        const upd = await client.query(`
          UPDATE public.pagamenti SET stato='pagato', importo=$1, updated_at=NOW()
          WHERE id=$2 AND corsa_id=$3 AND prenotazione_id=$4
            AND stato='autorizzazione' AND stripe_payment_intent=$5
          RETURNING id`, [expected/100, item.payment_id, item.corsa_id, item.prenotazione_id, item.pi_id]);
        if (upd.rowCount !== 1) throw new Error('conditional update affected zero rows');
        await client.query('COMMIT');
        totals.repaired++;
        log('REPAIRED', { payment_id: item.payment_id, cents: expected });
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        alert(item.payment_id, `apply failed: ${e.code || e.message}`);
      }
    }
  }
  log('SUMMARY', totals);
  console.log('TEST pilot only; no automatic schedule, no capture, no ride status changes.');
  if (totals.alerts) process.exitCode = 1;
} catch (e) {
  log('FATAL', { error: e.code || e.message });
  process.exitCode = 1;
} finally {
  if (client) {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock($1,$2)', [LOCK_KEY_1, LOCK_KEY_2]); }
      catch (e) { log('UNLOCK_WARNING', { error: e.message }); }
    }
    client.release();
  }
  await pool.end();
}
