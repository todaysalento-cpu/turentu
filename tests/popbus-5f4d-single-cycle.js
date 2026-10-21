// POPBUS 5F.4-D — UN SOLO ciclo reale worker R2 -> batch R3 -> PostgreSQL/Stripe TEST.
// Salvare in tests/popbus-5f4d-single-cycle.js. Non avvia alcuno scheduler.
import 'dotenv/config';
import Stripe from 'stripe';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../db/db.js';

const manifestPath = resolve('tests/popbus-5f4-fixture.json');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const eligibleSQL = `SELECT r.id, r.payment_intent_id FROM public.popbus_riserve r
 LEFT JOIN public.popbus_payment_reconciliation j ON j.riserva_id=r.id
 WHERE r.payment_intent_id IS NOT NULL AND r.prenotazione_id IS NULL
   AND (r.stato IN ('scaduta','annullata') OR (r.stato='riservata' AND r.expires_at <= NOW()))
   AND (j.id IS NULL OR j.stato IN ('pending','retry','processing'))
   AND (j.id IS NULL OR j.stato <> 'retry' OR j.prossimo_tentativo_at IS NULL OR j.prossimo_tentativo_at <= NOW())
   AND (j.id IS NULL OR j.stato <> 'processing' OR j.claimed_at < NOW() - INTERVAL '5 minutes')
 ORDER BY r.expires_at ASC LIMIT 21`;

let cycleStarted = false;
try {
  assert(process.env.POPBUS_5F4_RUN_ONCE === 'YES', 'Richiesto POPBUS_5F4_RUN_ONCE=YES');
  assert(process.env.POPBUS_5F4_RENDER_QUIET === 'YES', 'Confermare sospensione di producer e worker Render: POPBUS_5F4_RENDER_QUIET=YES');
  assert(process.env.POPBUS_PIXEL_FIRST_ENABLED === 'false', 'PIXEL-first locale deve essere false');
  assert(process.env.POPBUS_RECON_WORKER_ENABLED === 'false', 'Scheduler locale deve essere false');
  assert(process.env.POPBUS_RECON_ENABLED === 'NO' && process.env.POPBUS_RECON_APPROVED === 'NO', 'Autorizzazioni locali devono essere NO prima del test');
  assert(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 'Solo Stripe TEST');

  const m = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(m.test === 'POPBUS_5F4_A' && m.tag?.startsWith('POPBUS_5F4_'), 'Manifest inatteso');
  assert(m.phase === 'linked_expired_ready_for_controlled_cycle', 'Fase manifest inattesa: non ripetere questo test');
  assert(/^pi_[A-Za-z0-9]+$/.test(m.paymentIntentId ?? ''), 'PaymentIntent non valido');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const before = await stripe.paymentIntents.retrieve(m.paymentIntentId);
  assert(before.livemode === false && before.status === 'requires_capture' && before.amount_capturable === 200 && before.amount === 200 && before.currency === 'eur', 'Stripe TEST non nello stato iniziale atteso');
  assert(before.capture_method === 'manual' && before.metadata?.test === 'POPBUS_5F4' && before.metadata?.tipo === 'popbus_confirmed' && before.metadata?.requestId === m.requestId && before.metadata?.riservaId === String(m.riservaId) && before.metadata?.corsaId === String(m.corsaId) && before.metadata?.clienteId === String(m.clienteId), 'Metadati Stripe non corrispondono');

  const identity = await pool.query('SELECT current_database() AS db');
  assert(identity.rows[0]?.db === 'corse_db', 'Database inatteso');
  const fixture = await pool.query(`SELECT r.id,r.request_id,r.corsa_id,r.cliente_id,r.stato,r.prenotazione_id,r.payment_intent_id,c.veicolo_id,c.origine_address
    FROM public.popbus_riserve r JOIN public.corse c ON c.id=r.corsa_id WHERE r.id=$1`, [m.riservaId]);
  assert(fixture.rowCount === 1, 'Riserva mancante');
  const r = fixture.rows[0];
  assert(r.request_id === m.requestId && String(r.corsa_id) === String(m.corsaId) && String(r.cliente_id) === String(m.clienteId), 'Riserva non corrisponde al manifest');
  assert(String(r.veicolo_id) === String(m.veicoloId) && r.origine_address?.startsWith(m.tag), 'Corsa non riconosciuta come sintetica');
  assert(r.stato === 'scaduta' && r.prenotazione_id === null && r.payment_intent_id === m.paymentIntentId, 'Riserva non pronta');
  const jobBefore = await pool.query('SELECT id FROM public.popbus_payment_reconciliation WHERE riserva_id=$1 OR payment_intent_id=$2', [m.riservaId,m.paymentIntentId]);
  assert(jobBefore.rowCount === 0, 'Job preesistente: non eseguire');
  const candidates = await pool.query(eligibleSQL);
  assert(candidates.rowCount === 1 && String(candidates.rows[0].id) === String(m.riservaId) && candidates.rows[0].payment_intent_id === m.paymentIntentId,
    'ABORT: i candidati non sono esclusivamente la fixture. Non eseguire il ciclo.');
  console.log('[5F.4-D] Precheck PASS: unico candidato riserva', m.riservaId, '| Stripe TEST requires_capture');
  console.log('[5F.4-D] Avvio UNA chiamata diretta a runPopbusReconciliationCycle(), nessuno scheduler');

  // Le autorizzazioni vengono abilitate solo in QUESTO processo Node, dopo i controlli.
  process.env.POPBUS_RECON_WORKER_ENABLED = 'YES';
  process.env.POPBUS_RECON_ENABLED = 'YES';
  process.env.POPBUS_RECON_APPROVED = 'YES';
  const { runPopbusReconciliationCycle } = await import('../workers/popbus-reconciliation.worker.js');
  cycleStarted = true;
  const result = await runPopbusReconciliationCycle();
  process.env.POPBUS_RECON_WORKER_ENABLED = 'false';
  process.env.POPBUS_RECON_ENABLED = 'NO';
  process.env.POPBUS_RECON_APPROVED = 'NO';
  console.log('[5F.4-D] Risultato ciclo:', JSON.stringify(result));
  assert(result.outcome === 'completed' && result.scanned === 1 && result.dryRun === false, 'Ciclo non completato come atteso');
  assert(result.results?.length === 1 && String(result.results[0].riservaId) === String(m.riservaId), 'Risultati batch inattesi');
  assert(result.results[0].outcome === 'canceled', 'R3 non ha restituito outcome canceled: controllare senza ripetere');

  const after = await stripe.paymentIntents.retrieve(m.paymentIntentId);
  const job = await pool.query(`SELECT id,riserva_id,payment_intent_id,stato,tentativi,ultimo_errore
    FROM public.popbus_payment_reconciliation WHERE riserva_id=$1`, [m.riservaId]);
  const dbReserve = await pool.query('SELECT id,stato,payment_intent_id,prenotazione_id FROM public.popbus_riserve WHERE id=$1', [m.riservaId]);
  console.table([{ stripeStatus:after.status, livemode:after.livemode, amountReceived:after.amount_received,
    amountCapturable:after.amount_capturable, jobStatus:job.rows[0]?.stato ?? 'MISSING', jobCount:job.rowCount,
    reserveStatus:dbReserve.rows[0]?.stato ?? 'MISSING' }]);
  assert(after.livemode === false && after.status === 'canceled' && after.amount_received === 0 && after.amount_capturable === 0, 'Stripe NON conferma annullamento senza incasso');
  assert(job.rowCount === 1 && job.rows[0].stato === 'canceled' && job.rows[0].payment_intent_id === m.paymentIntentId, 'Job DB non canceled');
  assert(dbReserve.rowCount === 1 && dbReserve.rows[0].stato === 'scaduta' && dbReserve.rows[0].prenotazione_id === null, 'Riserva DB modificata in modo inatteso');
  const remaining = await pool.query(eligibleSQL);
  assert(remaining.rowCount === 0, 'Rimangono candidati eleggibili: controllare');
  const next = { ...m, phase:'reconciled_canceled_verified', reconciledAt:new Date().toISOString(), reconciliationJobId:String(job.rows[0].id) };
  const temp = manifestPath + '.5f4d.tmp';
  await writeFile(temp,JSON.stringify(next,null,2)+'\n');
  await rename(temp,manifestPath);
  console.log('[POPBUS 5F.4-D] PASS: worker R2 -> batch R3 -> Stripe TEST canceled -> DB canceled; zero incassi');
  console.log('Manifest aggiornato:',manifestPath);
  console.log('NON eliminare la fixture: preparare il test di idempotenza e cleanup separatamente.');
} catch (e) {
  console.error('[POPBUS 5F.4-D] FAIL/ABORT:',e?.stack || e);
  if (cycleStarted) console.error('Il ciclo potrebbe avere prodotto effetti: NON ripetere lo script. Verificare Stripe, DB e manifest.');
  process.exitCode = 1;
} finally {
  process.env.POPBUS_RECON_WORKER_ENABLED = 'false';
  process.env.POPBUS_RECON_ENABLED = 'NO';
  process.env.POPBUS_RECON_APPROVED = 'NO';
  await pool.end();
}
