// POPBUS 5F.4-E — idempotenza post-cancellazione; nessun nuovo pagamento.
// Salvare come tests/popbus-5f4e-idempotence.js (Node ESM).
import 'dotenv/config';
import Stripe from 'stripe';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../db/db.js';

const manifestPath = resolve('tests/popbus-5f4-fixture.json');
const assert = (x, msg) => { if (!x) throw new Error(msg); };
const eligibleSQL = `SELECT r.id FROM public.popbus_riserve r
 LEFT JOIN public.popbus_payment_reconciliation j ON j.riserva_id=r.id
 WHERE r.payment_intent_id IS NOT NULL AND r.prenotazione_id IS NULL
   AND (r.stato IN ('scaduta','annullata') OR (r.stato='riservata' AND r.expires_at <= NOW()))
   AND (j.id IS NULL OR j.stato IN ('pending','retry','processing'))
   AND (j.id IS NULL OR j.stato <> 'retry' OR j.prossimo_tentativo_at IS NULL OR j.prossimo_tentativo_at <= NOW())
   AND (j.id IS NULL OR j.stato <> 'processing' OR j.claimed_at < NOW() - INTERVAL '5 minutes')
 LIMIT 21`;
let started = false;
try {
  assert(process.env.POPBUS_5F4_IDEMPOTENCE === 'YES', 'Richiesto POPBUS_5F4_IDEMPOTENCE=YES');
  assert(process.env.POPBUS_5F4_RENDER_QUIET === 'YES', 'Confermare Render quiet');
  assert(process.env.POPBUS_PIXEL_FIRST_ENABLED === 'false' && process.env.POPBUS_RECON_WORKER_ENABLED === 'false', 'Scheduler locale deve essere disattivato');
  assert(process.env.POPBUS_RECON_ENABLED === 'NO' && process.env.POPBUS_RECON_APPROVED === 'NO', 'Autorizzazioni locali devono essere NO');
  assert(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 'Solo Stripe TEST');
  const m = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(m.test === 'POPBUS_5F4_A' && m.tag?.startsWith('POPBUS_5F4_'), 'Manifest inatteso');
  assert(m.phase === 'reconciled_canceled_verified', 'Fase manifest inattesa');
  assert(String(m.riservaId) === '16' && String(m.corsaId) === '944', 'Fixture diversa da quella collaudata');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const pi = await stripe.paymentIntents.retrieve(m.paymentIntentId);
  assert(!pi.livemode && pi.status === 'canceled' && pi.amount_received === 0 && pi.amount_capturable === 0, 'Stripe non cancellato');
  assert(pi.metadata?.tipo === 'popbus_confirmed' && pi.metadata?.riservaId === String(m.riservaId) && pi.metadata?.corsaId === String(m.corsaId) && pi.metadata?.clienteId === String(m.clienteId) && pi.metadata?.requestId === m.requestId, 'Metadati Stripe inattesi');
  const identity = await pool.query('SELECT current_database() AS db');
  assert(identity.rows[0]?.db === 'corse_db', 'Database inatteso');
  const fixture = await pool.query(`SELECT r.id,r.request_id,r.corsa_id,r.cliente_id,r.stato,r.payment_intent_id,r.prenotazione_id,c.veicolo_id,c.origine_address
    FROM public.popbus_riserve r JOIN public.corse c ON c.id=r.corsa_id WHERE r.id=$1`, [m.riservaId]);
  assert(fixture.rowCount === 1, 'Riserva assente');
  const r = fixture.rows[0];
  assert(r.request_id === m.requestId && String(r.corsa_id) === String(m.corsaId) && String(r.cliente_id) === String(m.clienteId) && String(r.veicolo_id) === String(m.veicoloId) && r.origine_address?.startsWith(m.tag), 'Fixture non riconosciuta');
  assert(r.stato === 'scaduta' && r.payment_intent_id === m.paymentIntentId && r.prenotazione_id === null, 'Riserva modificata');
  const job = await pool.query('SELECT id,stato,tentativi,payment_intent_id FROM public.popbus_payment_reconciliation WHERE riserva_id=$1', [m.riservaId]);
  assert(job.rowCount === 1 && String(job.rows[0].id) === String(m.reconciliationJobId) && job.rows[0].stato === 'canceled' && job.rows[0].payment_intent_id === m.paymentIntentId, 'Job inatteso');
  const attemptsBefore = job.rows[0].tentativi;
  const candidates = await pool.query(eligibleSQL);
  assert(candidates.rowCount === 0, 'ABORT: esistono candidati eleggibili; NON chiamare R2');
  console.log('[5F.4-E] Precheck PASS: zero candidati, job canceled, Stripe TEST canceled');
  process.env.POPBUS_RECON_WORKER_ENABLED = 'YES';
  process.env.POPBUS_RECON_ENABLED = 'YES';
  process.env.POPBUS_RECON_APPROVED = 'YES';
  const { runPopbusReconciliationCycle } = await import('../workers/popbus-reconciliation.worker.js');
  started = true;
  const result = await runPopbusReconciliationCycle();
  process.env.POPBUS_RECON_WORKER_ENABLED = 'false';
  process.env.POPBUS_RECON_ENABLED = 'NO';
  process.env.POPBUS_RECON_APPROVED = 'NO';
  console.log('[5F.4-E] Ciclo:', JSON.stringify(result));
  assert(result.outcome === 'completed' && result.scanned === 0 && result.dryRun === false && Array.isArray(result.results) && result.results.length === 0, 'Il secondo ciclo non e stato vuoto');
  const after = await stripe.paymentIntents.retrieve(m.paymentIntentId);
  const jobAfter = await pool.query('SELECT id,stato,tentativi,payment_intent_id FROM public.popbus_payment_reconciliation WHERE riserva_id=$1', [m.riservaId]);
  const reserveAfter = await pool.query('SELECT stato,payment_intent_id,prenotazione_id FROM public.popbus_riserve WHERE id=$1', [m.riservaId]);
  assert(after.status === 'canceled' && !after.livemode && after.amount_received === 0 && after.amount_capturable === 0, 'Stripe mutato');
  assert(jobAfter.rowCount === 1 && String(jobAfter.rows[0].id) === String(m.reconciliationJobId) && jobAfter.rows[0].stato === 'canceled' && jobAfter.rows[0].tentativi === attemptsBefore && jobAfter.rows[0].payment_intent_id === m.paymentIntentId, 'Job mutato o duplicato');
  assert(reserveAfter.rowCount === 1 && reserveAfter.rows[0].stato === 'scaduta' && reserveAfter.rows[0].payment_intent_id === m.paymentIntentId && reserveAfter.rows[0].prenotazione_id === null, 'Riserva mutata');
  const next = {...m, phase:'idempotence_verified', idempotenceVerifiedAt:new Date().toISOString()};
  const temp = manifestPath + '.5f4e.tmp';
  await writeFile(temp,JSON.stringify(next,null,2)+'\n');
  await rename(temp,manifestPath);
  console.log('[POPBUS 5F.4-E] PASS: secondo ciclo scanned=0, nessun nuovo job, Stripe canceled, zero incassi');
  console.table([{riservaId:m.riservaId,jobId:m.reconciliationJobId,jobStatus:jobAfter.rows[0].stato,stripeStatus:after.status,amountReceived:after.amount_received}]);
  console.log('NON eliminare la fixture fino al cleanup controllato.');
} catch(e) {
  console.error('[POPBUS 5F.4-E] FAIL/ABORT:', e?.stack || e);
  if(started) console.error('Ciclo gia chiamato: NON ripetere senza verifica manuale.');
  process.exitCode = 1;
} finally {
  process.env.POPBUS_RECON_WORKER_ENABLED = 'false';
  process.env.POPBUS_RECON_ENABLED = 'NO';
  process.env.POPBUS_RECON_APPROVED = 'NO';
  await pool.end();
}
