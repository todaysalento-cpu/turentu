// POPBUS 5F.3-E — Ripara SOLO fixture Stripe TEST e job manual_review.
// Non esegue worker, non cancella PI, non acquisisce denaro.
// Eseguire prima senza flag (diagnostica), poi con POPBUS_5F3_REPAIR=YES.
import 'dotenv/config';
import Stripe from 'stripe';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../db/db.js';
const fail = (message) => { throw new Error(message); };
const assert = (v, message) => { if (!v) fail(message); };
const eligibleSQL = `SELECT r.id FROM public.popbus_riserve r
 LEFT JOIN public.popbus_payment_reconciliation j ON j.riserva_id=r.id
 WHERE r.payment_intent_id IS NOT NULL AND r.prenotazione_id IS NULL
 AND (r.stato IN ('scaduta','annullata') OR (r.stato='riservata' AND r.expires_at <= NOW()))
 AND (j.id IS NULL OR j.stato IN ('pending','retry','processing'))
 AND (j.id IS NULL OR j.stato <> 'retry' OR j.prossimo_tentativo_at IS NULL OR j.prossimo_tentativo_at <= NOW())
 AND (j.id IS NULL OR j.stato <> 'processing' OR j.claimed_at < NOW() - INTERVAL '5 minutes')
 ORDER BY r.expires_at ASC LIMIT 21`;
try {
  const execute = process.env.POPBUS_5F3_REPAIR === 'YES';
  assert(process.env.POPBUS_5F3_RENDER_QUIET === 'YES', 'Confermare Render sospeso: POPBUS_5F3_RENDER_QUIET=YES');
  assert(process.env.POPBUS_RECON_WORKER_ENABLED === 'false' && process.env.POPBUS_RECON_ENABLED === 'NO' && process.env.POPBUS_RECON_APPROVED === 'NO', 'Worker/autorizzazioni locali devono essere disabilitati');
  assert(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 'Solo chiave Stripe TEST');
  const m = JSON.parse(await readFile(resolve('tests/popbus-5f3-fixture.json'),'utf8'));
  assert(m.test === 'POPBUS_5F3_A' && m.tag?.startsWith('POPBUS_5F3_'), 'Manifest inatteso');
  assert(m.phase === 'linked_expired_ready_for_controlled_cycle', 'Manifest fase inattesa');
  assert(String(m.riservaId) === '15' && String(m.corsaId) === '943' && String(m.clienteId) === '290', 'Identificativi fixture inattesi');
  const db = await pool.query('SELECT current_database() AS name');
  assert(db.rows[0]?.name === 'corse_db', 'Database inatteso');
  const rr = await pool.query(`SELECT r.*,c.veicolo_id,c.origine_address FROM public.popbus_riserve r JOIN public.corse c ON c.id=r.corsa_id WHERE r.id=$1`,[m.riservaId]);
  assert(rr.rowCount === 1, 'Riserva mancante');
  const r = rr.rows[0];
  assert(String(r.request_id) === String(m.requestId) && String(r.corsa_id) === String(m.corsaId) && String(r.cliente_id) === String(m.clienteId), 'Identita riserva diversa dal manifest');
  assert(String(r.veicolo_id) === String(m.veicoloId) && r.origine_address?.startsWith(m.tag), 'Corsa non sintetica');
  assert(r.stato === 'scaduta' && r.prenotazione_id === null && r.payment_intent_id === m.paymentIntentId && Number(r.prezzo) === 2, 'Stato riserva inatteso');
  const jr = await pool.query('SELECT * FROM public.popbus_payment_reconciliation WHERE riserva_id=$1 OR payment_intent_id=$2',[m.riservaId,m.paymentIntentId]);
  assert(jr.rowCount === 1, 'Atteso esattamente un job');
  const j = jr.rows[0];
  assert(String(j.riserva_id) === String(m.riservaId) && j.payment_intent_id === m.paymentIntentId && j.stato === 'manual_review', 'Job non corrisponde o non e manual_review');
  assert(String(j.ultimo_errore ?? '').includes('PaymentIntent:'), 'Motivo manual_review non atteso');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const pi = await stripe.paymentIntents.retrieve(m.paymentIntentId);
  assert(pi.livemode === false && pi.status === 'requires_capture' && pi.capture_method === 'manual' && pi.amount === 200 && pi.amount_received === 0 && pi.currency === 'eur', 'PaymentIntent non sicuro per riparazione');
  assert(pi.metadata?.test === 'POPBUS_5F3' && pi.metadata?.riserva_id === String(m.riservaId) && pi.metadata?.request_id === String(m.requestId), 'Metadata di origine fixture non corrispondono');
  const candidates = await pool.query(eligibleSQL);
  assert(candidates.rowCount === 0, 'Esistono riserve gia eleggibili: ABORT');
  const desired = { tipo:'popbus_confirmed',riservaId:String(r.id),corsaId:String(r.corsa_id),clienteId:String(r.cliente_id),requestId:String(r.request_id) };
  console.log('[5F.3-E] Precheck PASS',JSON.stringify({riservaId:String(r.id),jobId:String(j.id),jobStatus:j.stato,piStatus:pi.status,metadataAttuali:pi.metadata,metadataDaAggiungere:desired}));
  if (!execute) { console.log('[5F.3-E] DRY RUN: nessuna modifica. Per eseguire: set POPBUS_5F3_REPAIR=YES'); }
  else {
    // Stripe prima, DB dopo: in caso di errore intermedio il job resta manual_review.
    const updated = await stripe.paymentIntents.update(m.paymentIntentId,{metadata:desired},{idempotencyKey:`popbus-5f3-repair-${m.paymentIntentId}`});
    for (const [key,val] of Object.entries(desired)) assert(updated.metadata?.[key] === val, `Stripe metadata ${key} non aggiornato`);
    const changed = await pool.query(`UPDATE public.popbus_payment_reconciliation SET stato='pending',prossimo_tentativo_at=NULL,claimed_at=NULL,ultimo_errore=NULL,updated_at=NOW()
      WHERE id=$1 AND riserva_id=$2 AND payment_intent_id=$3 AND stato='manual_review' AND ultimo_errore LIKE 'PaymentIntent:%' RETURNING id,stato`,[j.id,m.riservaId,m.paymentIntentId]);
    assert(changed.rowCount === 1, 'Job non aggiornato: verificare DB e Stripe prima di riprovare');
    const after = await pool.query(eligibleSQL);
    assert(after.rowCount === 1 && String(after.rows[0].id) === String(m.riservaId), 'ATTENZIONE: candidati inattesi dopo repair. NON avviare worker.');
    console.log('[POPBUS 5F.3-E] PASS: metadati Stripe coerenti, job pending, unico candidato fixture. NON avviare ancora il worker.');
  }
} catch(e) { console.error('[POPBUS 5F.3-E] FAIL/ABORT:',e?.stack||e); process.exitCode=1; }
finally { await pool.end(); }
