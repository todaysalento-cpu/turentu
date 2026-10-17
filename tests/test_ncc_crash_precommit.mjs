// TURENTU NCC - Crash dopo cattura Stripe TEST, prima del COMMIT (scrittura controllata)
// Salva come tests/test_ncc_crash_precommit.mjs
// Esegui dal root con --env-file=.env. Crea dati DB e PaymentIntent TEST.
// Esecuzione UNA VOLTA SOLA. Crea una nuova corsa test, 3 PI TEST, cattura A e forza exit(86).
// Non modificare il servizio di produzione. Non eseguire se DB contiene clienti reali senza ambiente isolato.
import Stripe from 'stripe';
import fs from 'node:fs';
import { pool } from '../db/db.js';

const secret = process.env.STRIPE_SECRET_KEY || '';
if (!secret.startsWith('sk_test_')) throw new Error('STOP: Stripe TEST obbligatorio');
if (process.env.NCC_CRASH_CONFIRM !== 'CREATE_TEST_CRASH_FIXTURE') {
  throw new Error('STOP: serve NCC_CRASH_CONFIRM=CREATE_TEST_CRASH_FIXTURE');
}
const stripe = new Stripe(secret, { timeout: 15000, maxNetworkRetries: 1 });
const marker = `TURENTU_NCC_STRIPE_TEST_${Date.now()}_${process.pid}_CRASH`;
const specs = [
  { letter: 'A', authorized: 6765, final: 3075, start: 0, end: 100000, km: 100 },
  { letter: 'B', authorized: 2537, final: 1845, start: 20000, end: 80000, km: 60 },
  { letter: 'C', authorized: 1845, final: 1845, start: 40000, end: 100000, km: 60 },
];
let rideId = null;
const paymentIntents = [];
try {
  console.log('MARKER:', marker);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const vehicle = await client.query('SELECT id,posti_totali FROM public.veicolo WHERE posti_totali >= 3 ORDER BY id LIMIT 1');
    const users = await client.query('SELECT id FROM public.utente ORDER BY id LIMIT 3');
    if (!vehicle.rows.length || users.rows.length !== 3) throw new Error('Veicolo o tre utenti non disponibili');
    const startDate = new Date(Date.now() + 30 * 86400000);
    const endDate = new Date(startDate.getTime() + 2 * 3600000);
    const { rows: [ride] } = await client.query(`
      INSERT INTO public.corse
        (veicolo_id, start_datetime, arrivo_datetime, tipo_corsa, stato,
         posti_totali, posti_disponibili, posti_prenotati, distanza,
         prezzo_fisso, origine_address, destinazione_address)
      VALUES ($1,$2,$3,'condivisa','in_corso',$4,$5,3,100,67.65,$6,'NCC TEST RECON')
      RETURNING id`, [vehicle.rows[0].id, startDate, endDate,
        vehicle.rows[0].posti_totali, vehicle.rows[0].posti_totali - 3, marker]);
    rideId = ride.id;
    const { rows: [route] } = await client.query(`
      INSERT INTO public.corse_tratte
        (corsa_id,direzione,distanza_km,durata_secondi,partenza_prevista,arrivo_previsto,stato_temporale)
      VALUES ($1,'andata',100,7200,$2,$3,'programmato') RETURNING id`,
      [rideId,startDate,endDate]);
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const { rows: [booking] } = await client.query(`
        INSERT INTO public.prenotazioni
          (corsa_id,cliente_id,posti_prenotati,posti_richiesti,prezzo_totale,
           tratta_id,start_offset,end_offset,km_utente)
        VALUES ($1,$2,1,1,$3,$4,$5,$6,$7) RETURNING id`,
        [rideId,users.rows[i].id,s.final/100,route.id,s.start,s.end,s.km]);
      s.bookingId = booking.id;
    }
    await client.query('COMMIT');
    console.log('CORSA DB:', rideId, 'PRENOTAZIONI:', specs.map(s => s.bookingId));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }

  for (const s of specs) {
    const pi = await stripe.paymentIntents.create({
      amount: s.authorized, currency: 'eur', capture_method: 'manual',
      confirm: true, payment_method: 'pm_card_visa', payment_method_types: ['card'],
      description: `${marker} ${s.letter}`,
      metadata: { test_run: marker, corsa_id: String(rideId), passenger: s.letter },
    }, { idempotencyKey: `${marker}_authorize_${s.letter}` });
    paymentIntents.push(pi.id);
    if (pi.livemode || pi.status !== 'requires_capture' || pi.amount_capturable < s.final) {
      throw new Error(`Autorizzazione ${s.letter} non valida: ${pi.status}`);
    }
    // Scriviamo la riga pagamento prima di catturare: recovery sempre tracciabile.
    const { rows: [payment] } = await pool.query(`
      INSERT INTO public.pagamenti
        (prenotazione_id,corsa_id,importo,stato,stripe_payment_intent,tipo_corsa,currency)
      VALUES ($1,$2,$3,'autorizzazione',$4,'condivisa','eur') RETURNING id`,
      [s.bookingId,rideId,s.authorized/100,pi.id]);
    s.paymentId = payment.id;
    console.log(`AUTH ${s.letter}: pagamento=${s.paymentId}, PI=${pi.id}`);
  }

  // Scenario di crash controllato: transazione SQL aperta durante cattura Stripe.
  // I dati della fixture sono gia' stati COMMITtati, quindi sono recuperabili.
  const a = specs[0];
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query('SELECT id FROM public.corse WHERE id=$1 FOR UPDATE', [rideId]);
    await tx.query('SELECT id FROM public.pagamenti WHERE id=$1 FOR UPDATE', [a.paymentId]);
    await tx.query("UPDATE public.corse SET stato='completata' WHERE id=$1 AND stato='in_corso'", [rideId]);
    const pi = paymentIntents[0];
    const captured = await stripe.paymentIntents.capture(pi,
      { amount_to_capture: a.final },
      { idempotencyKey: `capture-payment-${a.paymentId}-${a.final}` });
    if (captured.livemode || captured.status !== 'succeeded' || captured.amount_received !== a.final) {
      throw new Error(`Cattura A inattesa: ${captured.status}`);
    }
    await tx.query("UPDATE public.pagamenti SET stato='pagato',importo=$1,updated_at=NOW() WHERE id=$2",
      [a.final / 100, a.paymentId]);
    const within = await tx.query('SELECT stato,importo FROM public.pagamenti WHERE id=$1', [a.paymentId]);
    if (within.rows[0]?.stato !== 'pagato') throw new Error('UPDATE transazionale non riuscito');
    // Uscita immediata: nessun COMMIT/ROLLBACK/finally, la connessione viene chiusa dal SO.
    // Postgres annullera' la transazione. Stripe rimane succeeded.
    fs.writeSync(1, `\nCAPTURE_SUCCEEDED_PI=${pi}\n`);
    fs.writeSync(1, `CRASH_FIXTURE_CORSA=${rideId} PAGAMENTO=${a.paymentId} MARKER=${marker}\n`);
    fs.writeSync(1, `INSIDE_TX=pagato; NO_COMMIT; EXIT_FORCED=86\n`);
    fs.writeSync(1, 'NON RILANCIARE QUESTO SCRIPT. Verificare DB/Stripe e poi worker READ ONLY.\n');
    process.exit(86);
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
} catch (e) {
  console.error('ERRORE:', e.stack || e.message);
  console.error('RISORSE POTENZIALMENTE CREATE: CORSA=', rideId, 'PI=', paymentIntents.join(','));
  console.error('NON RILANCIARE senza audit delle risorse residue.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
