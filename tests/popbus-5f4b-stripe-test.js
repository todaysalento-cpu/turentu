// POPBUS 5F.4-B — Stripe TEST manual capture con metadata conformi a R3.
// Salvare in tests/popbus-5f4b-stripe-test.js; eseguire da project-root.
import 'dotenv/config';
import Stripe from 'stripe';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../db/db.js';

const manifestPath = resolve('tests/popbus-5f4-fixture.json');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let exitCode = 0;
try {
  assert(process.env.POPBUS_5F4_STRIPE === 'YES', 'Richiesto POPBUS_5F4_STRIPE=YES');
  assert(process.env.POPBUS_PIXEL_FIRST_ENABLED === 'false', 'PIXEL-first locale non disabilitato');
  assert(process.env.POPBUS_RECON_WORKER_ENABLED === 'false', 'Scheduler locale non disabilitato');
  assert(process.env.POPBUS_RECON_ENABLED === 'NO', 'Riconciliazione non deve essere abilitata');
  assert(process.env.POPBUS_RECON_APPROVED === 'NO', 'Riconciliazione non deve essere approvata');
  assert(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 'Solo Stripe sk_test_');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(manifest.test === 'POPBUS_5F4_A' && manifest.tag?.startsWith('POPBUS_5F4_'), 'Manifest inatteso');
  assert(manifest.phase === 'fixture_created_no_stripe' && !manifest.paymentIntentId, 'Manifest gia avanzato: non creare PI');
  const db = await pool.query('SELECT current_database() AS db');
  assert(db.rows[0]?.db === 'corse_db', 'Database inatteso');
  const {rows} = await pool.query(`SELECT r.id,r.corsa_id,r.cliente_id,r.request_id,r.prezzo,r.currency,r.stato,r.payment_intent_id,r.prenotazione_id,
    c.origine_address,u.email FROM public.popbus_riserve r
    JOIN public.corse c ON c.id=r.corsa_id JOIN public.utente u ON u.id=r.cliente_id
    WHERE r.id=$1`, [manifest.riservaId]);
  assert(rows.length === 1, 'Riserva fixture mancante');
  const r = rows[0];
  assert(String(r.corsa_id) === String(manifest.corsaId) && String(r.cliente_id) === String(manifest.clienteId), 'Identificativi non coerenti');
  assert(r.request_id === manifest.requestId && r.origine_address?.startsWith(manifest.tag) && r.email?.startsWith(manifest.tag.toLowerCase()), 'Fixture non riconosciuta');
  assert(r.stato === 'riservata' && r.payment_intent_id === null && r.prenotazione_id === null, 'Riserva non nello stato atteso');
  assert(r.currency === 'eur' && Number(r.prezzo) === 2, 'Importo/valuta inattesi');
  const job = await pool.query('SELECT id FROM public.popbus_payment_reconciliation WHERE riserva_id=$1', [r.id]);
  assert(job.rowCount === 0, 'Job gia presente: interrompere');

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const metadata = {
    tipo: 'popbus_confirmed',
    riservaId: String(r.id),
    corsaId: String(r.corsa_id),
    clienteId: String(r.cliente_id),
    requestId: String(r.request_id),
    test: 'POPBUS_5F4'
  };
  // Stessa chiave per recuperare un errore tra chiamata Stripe e salvataggio manifest.
  const pi = await stripe.paymentIntents.create({
    amount: 200, currency: 'eur', capture_method: 'manual', confirm: true,
    payment_method: 'pm_card_visa', payment_method_types: ['card'],
    description: `POPBUS 5F.4 TEST ${manifest.tag}`,
    metadata
  }, { idempotencyKey: `popbus-5f4b-${manifest.requestId}` });
  assert(pi.livemode === false && pi.status === 'requires_capture' && pi.amount === 200 && pi.amount_capturable === 200 && pi.amount_received === 0, `Stripe stato inatteso: ${pi.status}`);
  assert(Object.entries(metadata).every(([k,v]) => pi.metadata?.[k] === v), 'Stripe metadata non conformi a R3');
  const updated = { ...manifest, paymentIntentId: pi.id, phase: 'stripe_test_authorized_not_linked', stripeStatus: pi.status, stripeCreatedAt: new Date().toISOString() };
  const tmp = manifestPath + '.5f4b.tmp';
  await writeFile(tmp, JSON.stringify(updated,null,2)+'\n');
  await rename(tmp,manifestPath);
  console.log('[POPBUS 5F.4-B] PASS: PaymentIntent Stripe TEST autorizzato con metadata R3, NON collegato al DB');
  console.table([{riservaId:r.id,paymentIntentId:pi.id,status:pi.status,amountCapturable:pi.amount_capturable,livemode:pi.livemode}]);
  console.log('Manifest aggiornato:',manifestPath);
  console.log('NON avviare il worker.');
} catch (error) {
  exitCode = 1;
  console.error('[POPBUS 5F.4-B] ABORT:',error.message);
  console.error('In caso di errore dopo Stripe, NON cambiare requestId e NON cancellare il manifest.');
} finally {
  await pool.end();
  process.exitCode = exitCode;
}
