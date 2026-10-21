// POPBUS 5F.3-B — Stripe TEST manual capture, SENZA associare ancora la riserva.
// Salva in tests/popbus-5f3b-stripe-test.js. Node ESM.
import 'dotenv/config';
import Stripe from 'stripe';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../db/db.js';

const path = resolve('tests/popbus-5f3-fixture.json');
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
let exitCode = 0;
try {
  assert(process.env.POPBUS_5F3_STRIPE === 'YES', 'Richiesto POPBUS_5F3_STRIPE=YES');
  assert(process.env.POPBUS_PIXEL_FIRST_ENABLED === 'false', 'PIXEL-first locale non disabilitato');
  assert(process.env.POPBUS_RECON_WORKER_ENABLED === 'false', 'Scheduler locale non disabilitato');
  assert(process.env.POPBUS_RECON_ENABLED === 'NO', 'Riconciliazione non deve essere abilitata');
  assert(process.env.POPBUS_RECON_APPROVED === 'NO', 'Riconciliazione non deve essere approvata');
  assert(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 'Obbligatoria chiave Stripe sk_test_');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  assert(manifest.test === 'POPBUS_5F3_A' && manifest.tag?.startsWith('POPBUS_5F3_'), 'Manifest non riconosciuto');
  assert(manifest.phase === 'fixture_created_no_stripe' && !manifest.paymentIntentId, 'Manifest gia avanzato: non creare un altro PI');
  const db = await pool.query('SELECT current_database() AS db');
  assert(db.rows[0].db === 'corse_db', 'Database inatteso');
  const q = await pool.query(`SELECT r.id,r.corsa_id,r.cliente_id,r.request_id,r.prezzo,r.currency,r.stato,r.payment_intent_id,r.prenotazione_id,
    c.origine_address, u.email FROM public.popbus_riserve r
    JOIN public.corse c ON c.id=r.corsa_id JOIN public.utente u ON u.id=r.cliente_id
    WHERE r.id=$1`, [manifest.riservaId]);
  assert(q.rowCount === 1, 'Riserva fixture mancante');
  const r=q.rows[0];
  assert(String(r.corsa_id)===String(manifest.corsaId) && String(r.cliente_id)===String(manifest.clienteId), 'FK fixture non coerenti');
  assert(r.request_id===manifest.requestId && r.origine_address?.startsWith(manifest.tag), 'Fixture non riconosciuta');
  assert(r.stato==='riservata' && r.payment_intent_id===null && r.prenotazione_id===null, 'Riserva non nello stato atteso');
  assert(r.currency==='eur' && Number(r.prezzo)===2, 'Prezzo inatteso: non creare PI');
  const stripe=new Stripe(process.env.STRIPE_SECRET_KEY);
  // Idempotenza: in caso di errore dopo Stripe, ripetere con la stessa chiave non duplica il PI.
  const key=`popbus-5f3b-${manifest.requestId}`;
  const pi=await stripe.paymentIntents.create({
    amount:200, currency:'eur', capture_method:'manual', confirm:true,
    payment_method:'pm_card_visa', payment_method_types:['card'],
    description:`POPBUS 5F.3 TEST ${manifest.tag}`,
    metadata:{test:'POPBUS_5F3', request_id:manifest.requestId, riserva_id:String(manifest.riservaId)}
  },{idempotencyKey:key});
  assert(pi.livemode===false && pi.status==='requires_capture' && pi.amount_capturable===200, `PI non autorizzato come previsto: ${pi.status}`);
  const updated={...manifest,paymentIntentId:pi.id,phase:'stripe_test_authorized_not_linked',stripeStatus:pi.status, stripeCreatedAt:new Date().toISOString()};
  const tmp=path+'.5f3b.tmp';
  await writeFile(tmp,JSON.stringify(updated,null,2)+'\n',{flag:'w'});
  await rename(tmp,path);
  console.log('[POPBUS 5F.3-B] PASS: PI TEST autorizzato, NON collegato alla riserva');
  console.table([{riservaId:manifest.riservaId,paymentIntentId:pi.id,status:pi.status,amountCapturable:pi.amount_capturable,livemode:pi.livemode}]);
  console.log('Manifest aggiornato:',path);
  console.log('NON avviare il worker. Il PI non e ancora collegato al DB.');
} catch(e) {
  exitCode=1;
  console.error('[POPBUS 5F.3-B] ABORT:',e.message);
  console.error('Se Stripe ha creato il PI prima di un errore locale, conservare il manifest e NON cambiare requestId: la chiave idempotente permette il recupero.');
} finally {
  await pool.end();
  process.exitCode=exitCode;
}
