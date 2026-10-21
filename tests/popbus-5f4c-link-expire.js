// POPBUS 5F.4-C — collega PI TEST e marca la riserva scaduta; NON esegue R3/worker.
// Salvare come tests/popbus-5f4c-link-expire.js (Node ESM).
import 'dotenv/config';
import Stripe from 'stripe';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../db/db.js';

const manifestPath = resolve('tests/popbus-5f4-fixture.json');
const assert = (v, msg) => { if (!v) throw new Error(msg); };
let client;
let committed = false;
try {
  assert(process.env.POPBUS_5F4_LINK === 'YES', 'Richiesto POPBUS_5F4_LINK=YES');
  assert(process.env.POPBUS_PIXEL_FIRST_ENABLED === 'false', 'PIXEL-first locale deve essere false');
  assert(process.env.POPBUS_RECON_WORKER_ENABLED === 'false', 'Scheduler locale deve essere false');
  assert(process.env.POPBUS_RECON_ENABLED === 'NO', 'POPBUS_RECON_ENABLED deve essere NO');
  assert(process.env.POPBUS_RECON_APPROVED === 'NO', 'POPBUS_RECON_APPROVED deve essere NO');
  assert(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 'Chiave Stripe TEST obbligatoria');
  const m = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(m.test === 'POPBUS_5F4_A' && m.tag?.startsWith('POPBUS_5F4_'), 'Manifest inatteso');
  assert(m.phase === 'stripe_test_authorized_not_linked', 'Fase manifest inattesa: non ripetere lo script');
  assert(/^pi_[A-Za-z0-9]+$/.test(m.paymentIntentId ?? ''), 'PaymentIntent ID non valido');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const pi = await stripe.paymentIntents.retrieve(m.paymentIntentId);
  assert(!pi.livemode && pi.status === 'requires_capture' && pi.amount_capturable === 200 && pi.amount === 200 && pi.currency === 'eur', 'PI non e piu autorizzato TEST per 2 EUR');
  assert(pi.capture_method === 'manual' && pi.metadata?.test === 'POPBUS_5F4' && pi.metadata?.tipo === 'popbus_confirmed' && pi.metadata?.requestId === m.requestId && pi.metadata?.riservaId === String(m.riservaId) && pi.metadata?.corsaId === String(m.corsaId) && pi.metadata?.clienteId === String(m.clienteId), 'Metadati PI non coerenti con manifest');

  client = await pool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '15s'");
  const identity = await client.query('SELECT current_database() AS db');
  assert(identity.rows[0]?.db === 'corse_db', 'Database inatteso');
  // Blocco della corsa prima della riserva: stesso ordine di lock del servizio R3.
  const corsa = await client.query('SELECT id,veicolo_id,origine_address FROM public.corse WHERE id=$1 FOR UPDATE', [m.corsaId]);
  assert(corsa.rowCount === 1 && String(corsa.rows[0].veicolo_id) === String(m.veicoloId) && corsa.rows[0].origine_address?.startsWith(m.tag), 'Corsa sintetica non riconosciuta');
  const q = await client.query(`SELECT id,request_id,corsa_id,cliente_id,stato,payment_intent_id,prenotazione_id,prezzo,currency
    FROM public.popbus_riserve WHERE id=$1 FOR UPDATE`, [m.riservaId]);
  assert(q.rowCount === 1, 'Riserva assente');
  const r = q.rows[0];
  assert(r.request_id === m.requestId && String(r.corsa_id) === String(m.corsaId) && String(r.cliente_id) === String(m.clienteId), 'Riserva non corrisponde alla fixture');
  assert(r.stato === 'riservata' && r.payment_intent_id === null && r.prenotazione_id === null, 'Riserva gia modificata: interrompere');
  assert(Number(r.prezzo) === 2 && r.currency === 'eur', 'Prezzo o valuta inattesi');
  const other = await client.query(`SELECT r.id FROM public.popbus_riserve r
    LEFT JOIN public.popbus_payment_reconciliation j ON j.riserva_id=r.id
    WHERE r.id <> $1 AND r.payment_intent_id IS NOT NULL AND r.prenotazione_id IS NULL
      AND (r.stato IN ('scaduta','annullata') OR (r.stato='riservata' AND r.expires_at <= NOW()))
      AND (j.id IS NULL OR j.stato IN ('pending','retry','processing'))
      AND (j.id IS NULL OR j.stato <> 'retry' OR j.prossimo_tentativo_at IS NULL OR j.prossimo_tentativo_at <= NOW())
      AND (j.id IS NULL OR j.stato <> 'processing' OR j.claimed_at < NOW() - INTERVAL '5 minutes')
    LIMIT 1`, [m.riservaId]);
  assert(other.rowCount === 0, 'ABORT: altra riserva eleggibile. Non avviare worker.');
  const job = await client.query('SELECT id FROM public.popbus_payment_reconciliation WHERE riserva_id=$1 OR payment_intent_id=$2 LIMIT 1', [m.riservaId, m.paymentIntentId]);
  assert(job.rowCount === 0, 'Job riconciliazione gia presente: interrompere');
  const update = await client.query(`UPDATE public.popbus_riserve
    SET payment_intent_id=$2, stato='scaduta', updated_at=NOW()
    WHERE id=$1 AND stato='riservata' AND payment_intent_id IS NULL AND prenotazione_id IS NULL
    RETURNING id,stato,payment_intent_id`, [m.riservaId, m.paymentIntentId]);
  assert(update.rowCount === 1, 'Update non effettuato');
  await client.query('COMMIT');
  committed = true;
  const next = {...m, phase:'linked_expired_ready_for_controlled_cycle', linkedAt:new Date().toISOString()};
  const tmp = manifestPath + '.5f4c.tmp';
  await writeFile(tmp, JSON.stringify(next,null,2)+'\n');
  await rename(tmp, manifestPath);
  console.log('[POPBUS 5F.4-C] PASS: PI TEST collegato, riserva scaduta; worker NON eseguito');
  console.table(update.rows);
  console.log('Manifest aggiornato:',manifestPath);
  console.log('ATTENZIONE: riserva ora eleggibile al batch R3. Non avviare server o worker automatici.');
} catch (e) {
  if (client && !committed) { try { await client.query('ROLLBACK'); } catch {} }
  console.error('[POPBUS 5F.4-C] ABORT:',e.message);
  if (committed) console.error('DB COMMIT effettuato: se il manifest non e aggiornato, NON ripetere; verificare DB e manifest.');
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
