// POPBUS V2: riconciliazione autorizzazioni non convertite in prenotazioni.
// NON importa scheduler; NON effettua capture; chiamare solo da runner esplicito.
import Stripe from 'stripe';
import { pool } from '../../../db/db.js';

const stripe = () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !key.startsWith('sk_test_')) throw new Error('R3 test-only: richiesta STRIPE_SECRET_KEY sk_test_');
  return new Stripe(key, { apiVersion: '2022-11-15' });
};
const cents = value => Math.round(Number(value) * 100);
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

async function transaction(fn) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const out = await fn(db); await db.query('COMMIT'); return out; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

// Lock order identico a confirmed-booking.service.js: corsa -> riserva.
// La transizione della riserva a 'scaduta' precede la chiamata esterna Stripe.
// Il servizio di conferma rifiuta sempre riserve non 'riservata'.
async function claim(riservaId) {
  return transaction(async db => {
    const loc = await db.query('SELECT corsa_id FROM public.popbus_riserve WHERE id=$1', [riservaId]);
    if (!loc.rows.length) return { outcome: 'not_found' };
    await db.query('SELECT id FROM public.corse WHERE id=$1 FOR UPDATE', [loc.rows[0].corsa_id]);
    const res = await db.query('SELECT * FROM public.popbus_riserve WHERE id=$1 FOR UPDATE', [riservaId]);
    const r = res.rows[0];
    if (!r || r.prenotazione_id != null || r.stato === 'confermata') return { outcome: 'confirmed' };
    if (!r.payment_intent_id) return { outcome: 'no_pi' };
    if (r.stato === 'riservata' && new Date(r.expires_at).getTime() > Date.now()) return { outcome: 'not_expired' };
    if (r.stato === 'riservata') {
      await db.query("UPDATE public.popbus_riserve SET stato='scaduta', updated_at=NOW() WHERE id=$1", [r.id]);
    } else if (!['scaduta','annullata'].includes(r.stato)) return { outcome: 'unexpected_state' };
    await db.query(`INSERT INTO public.popbus_payment_reconciliation(riserva_id,payment_intent_id,stato)
      VALUES($1,$2,'pending') ON CONFLICT (riserva_id) DO NOTHING`, [r.id,r.payment_intent_id]);
    const rec = await db.query('SELECT * FROM public.popbus_payment_reconciliation WHERE riserva_id=$1 FOR UPDATE', [r.id]);
    const job = rec.rows[0];
    if (!job || job.payment_intent_id !== r.payment_intent_id) return { outcome: 'identity_conflict' };
    if (job.stato === 'canceled') return { outcome: 'already_canceled' };
    if (job.stato === 'manual_review') return { outcome: 'manual_review' };
    // Stale claims are retried after 5 minutes, for crash recovery.
    if (job.stato === 'processing' && job.claimed_at && Date.now() - new Date(job.claimed_at).getTime() < 300000)
      return { outcome: 'busy' };
    if (job.stato === 'retry' && job.prossimo_tentativo_at && new Date(job.prossimo_tentativo_at) > new Date())
      return { outcome: 'backoff' };
    const updated = await db.query(`UPDATE public.popbus_payment_reconciliation
      SET stato='processing', claimed_at=NOW(), tentativi=tentativi+1, updated_at=NOW(), ultimo_errore=NULL
      WHERE id=$1 RETURNING tentativi`, [job.id]);
    return { outcome: 'claimed', riserva: r, jobId: job.id, attempt: updated.rows[0].tentativi };
  });
}

function checkIdentity(pi, r) {
  return pi && pi.livemode === (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_') &&
    pi.id === r.payment_intent_id && pi.currency === 'eur' && pi.capture_method === 'manual' &&
    pi.amount === cents(r.prezzo) && pi.metadata?.tipo === 'popbus_confirmed' &&
    String(pi.metadata?.riservaId) === String(r.id) &&
    String(pi.metadata?.corsaId) === String(r.corsa_id) &&
    String(pi.metadata?.clienteId) === String(r.cliente_id) &&
    String(pi.metadata?.requestId) === String(r.request_id);
}

async function finish(jobId, attempt, status, message = null) {
  const backoff = status === 'retry' ? 60 : 0;
  const result = await pool.query(`UPDATE public.popbus_payment_reconciliation
    SET stato=$2::varchar, ultimo_errore=$3, prossimo_tentativo_at=CASE WHEN $2::varchar='retry' THEN NOW() + ($4::int * INTERVAL '1 minute') ELSE NULL END,
        claimed_at=NULL, updated_at=NOW() WHERE id=$1 AND stato='processing' AND tentativi=$5`,
    [jobId,status,message,backoff,attempt]);
  if (result.rowCount !== 1) throw new Error('Proprietà tentativo riconciliazione persa');
}

export async function riconciliaRiservaPopbus(riservaId, { dryRun = true } = {}) {
  if (!positiveId(riservaId)) throw new Error('riservaId non valido');
  if (dryRun) {
    const { rows } = await pool.query(`SELECT id, corsa_id, stato, expires_at, prenotazione_id,
      payment_intent_id FROM public.popbus_riserve WHERE id=$1`, [riservaId]);
    const r = rows[0];
    return { dryRun:true, riservaId, eleggibile: !!r && !r.prenotazione_id &&
      !!r.payment_intent_id && (['scaduta','annullata'].includes(r.stato) ||
      (r.stato === 'riservata' && new Date(r.expires_at) <= new Date())) };
  }
  if (process.env.POPBUS_RECON_ENABLED !== 'YES') throw new Error('POPBUS_RECON_ENABLED=YES richiesto');
  if (process.env.POPBUS_RECON_APPROVED !== 'YES') throw new Error('POPBUS_RECON_APPROVED=YES richiesto');
  if (!(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_')) throw new Error('R3 test-only: richiesta STRIPE_SECRET_KEY sk_test_');
  // Il lock advisory di sessione resta attivo durante TUTTE le chiamate Stripe.
  // Si libera automaticamente anche se il processo o la connessione cade.
  const guard = await pool.connect();
  let locked = false;
  try {
    const key = `popbus-reconciliation-v2:${riservaId}`;
    const lock = await guard.query('SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired', [key]);
    if (!lock.rows[0].acquired) return { riservaId, outcome: 'busy' };
    locked = true;

    const claimed = await claim(riservaId);
    if (claimed.outcome !== 'claimed') return { riservaId, ...claimed };
    const { riserva: r, jobId, attempt } = claimed;
    try {
      const api = stripe();
      const pi = await api.paymentIntents.retrieve(r.payment_intent_id);
      if (!checkIdentity(pi, r)) {
        await finish(jobId,attempt,'manual_review','PaymentIntent: identità/importo/ambiente non coerenti');
        return { riservaId, outcome:'manual_review', reason:'identity_mismatch' };
      }
      if (pi.status === 'canceled') {
        await finish(jobId,attempt,'canceled');
        return { riservaId, outcome:'already_canceled_stripe' };
      }
      if (pi.status === 'succeeded') {
        await finish(jobId,attempt,'manual_review','PaymentIntent già catturato: verifica manuale');
        return { riservaId, outcome:'manual_review', reason:'already_succeeded' };
      }
      if (!['requires_capture','requires_payment_method','requires_confirmation','requires_action'].includes(pi.status)) {
        await finish(jobId,attempt,'manual_review',`Stato Stripe non cancellato automaticamente: ${pi.status}`);
        return { riservaId, outcome:'manual_review', reason:pi.status };
      }
      const canceled = await api.paymentIntents.cancel(pi.id, {}, { idempotencyKey:`popbus-recon-cancel-${r.id}` });
      if (canceled.status !== 'canceled') throw new Error(`Stripe status inatteso: ${canceled.status}`);
      await finish(jobId,attempt,'canceled');
      return { riservaId, outcome:'canceled', paymentIntentId:pi.id };
    } catch (error) {
      // Se Stripe ha cancellato ma il DB non è stato aggiornato, il retry rilegge Stripe.
      try { await finish(jobId,attempt,'retry',String(error.message || error).slice(0,1000)); }
      catch (dbError) { error.dbFinalizeError = dbError.message; }
      throw error;
    }
  } finally {
    try {
      if (locked) await guard.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [`popbus-reconciliation-v2:${riservaId}`]);
      guard.release();
    } catch (unlockError) {
      guard.release(true);
      throw unlockError;
    }
  }
}

export async function riconciliaBatchPopbus({ limit = 20, dryRun = true } = {}) {
  const n = Math.min(Math.max(Number(limit) || 20,1),100);
  const { rows } = await pool.query(`SELECT r.id FROM public.popbus_riserve r
    LEFT JOIN public.popbus_payment_reconciliation j ON j.riserva_id=r.id
    WHERE r.payment_intent_id IS NOT NULL AND r.prenotazione_id IS NULL
      AND (r.stato IN ('scaduta','annullata') OR (r.stato='riservata' AND r.expires_at <= NOW()))
      AND (j.id IS NULL OR j.stato IN ('pending','retry','processing'))
      AND (j.id IS NULL OR j.stato <> 'retry' OR j.prossimo_tentativo_at IS NULL OR j.prossimo_tentativo_at <= NOW())
      AND (j.id IS NULL OR j.stato <> 'processing' OR j.claimed_at < NOW() - INTERVAL '5 minutes')
    ORDER BY r.expires_at ASC LIMIT $1`, [n]);
  const results = [];
  for (const r of rows) {
    try { results.push(await riconciliaRiservaPopbus(r.id,{dryRun})); }
    catch (e) { results.push({riservaId:r.id,outcome:'error',message:e.message}); }
  }
  return { dryRun, scanned:rows.length, results };
}
