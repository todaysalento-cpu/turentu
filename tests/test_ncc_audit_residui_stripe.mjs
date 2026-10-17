// TURENTU NCC - AUDIT RESIDUI STRIPE TEST / POSTGRESQL (SOLO LETTURA)
// Salva in tests/test_ncc_audit_residui_stripe.mjs
// Esegui da project-root: node --env-file=.env tests/test_ncc_audit_residui_stripe.mjs
// Non importa corse.service, Redis, worker, cache; non modifica dati.
import Stripe from 'stripe';
import { pool } from '../db/db.js';

const key = process.env.STRIPE_SECRET_KEY || '';
if (!key.startsWith('sk_test_')) {
  console.error('BLOCCATO: STRIPE_SECRET_KEY deve iniziare con sk_test_');
  process.exit(1);
}
const stripe = new Stripe(key, { timeout: 10000, maxNetworkRetries: 0 });
const MARKER = 'TURENTU_NCC_STRIPE_TEST_';
const money = cents => `${(cents / 100).toFixed(2)} EUR`;
let errors = 0;
try {
  console.log('\n=== NCC AUDIT RESIDUI - READ ONLY ===');
  const rides = await pool.query(`
    SELECT c.id, c.origine_address AS marker, c.stato, c.prezzo_fisso,
           c.posti_totali, c.posti_disponibili, c.start_datetime,
           (SELECT COUNT(*)::int FROM public.prenotazioni p WHERE p.corsa_id=c.id) AS prenotazioni
    FROM public.corse c
    WHERE c.origine_address LIKE $1
    ORDER BY c.id DESC LIMIT 100
  `, [`${MARKER}%`]);
  console.log(`\nCorse marcate trovate (max 100): ${rides.rows.length}`);
  for (const ride of rides.rows) {
    console.log(`\nCORSA ${ride.id} | ${ride.stato} | prezzo_fisso=${ride.prezzo_fisso} | prenotazioni=${ride.prenotazioni}`);
    console.log(`MARKER: ${ride.marker}`);
    const payments = await pool.query(`
      SELECT p.id AS prenotazione_id, p.prezzo_totale,
             g.id AS pagamento_id, g.stato AS pagamento_stato,
             g.importo AS pagamento_importo, g.stripe_payment_intent
      FROM public.prenotazioni p
      LEFT JOIN public.pagamenti g ON g.prenotazione_id=p.id AND g.corsa_id=p.corsa_id
      WHERE p.corsa_id=$1 ORDER BY p.id, g.id
    `, [ride.id]);
    if (!payments.rows.length) console.log('  Nessuna prenotazione presente.');
    for (const row of payments.rows) {
      const piId = row.stripe_payment_intent;
      console.log(`  PREN ${row.prenotazione_id} quota=${row.prezzo_totale} | PAG ${row.pagamento_id ?? 'ASSENTE'} stato=${row.pagamento_stato ?? '-'} importo=${row.pagamento_importo ?? '-'} PI=${piId ?? 'ASSENTE'}`);
      if (!piId) continue;
      try {
        const pi = await stripe.paymentIntents.retrieve(piId);
        console.log(`    STRIPE: ${pi.status} | livemode=${pi.livemode} | authorized=${money(pi.amount)} | capturable=${money(pi.amount_capturable)} | received=${money(pi.amount_received)}`);
        if (pi.livemode) { console.log('    ATTENZIONE: oggetto LIVE inatteso'); errors++; }
      } catch (err) {
        console.log(`    STRIPE NON LEGGIBILE: ${err.type || 'errore'} ${err.code || ''}`);
        errors++;
      }
    }
  }

  // Esamina gli ultimi 100 PI Stripe TEST per trovare eventuali oggetti
  // creati dal test ma non collegati a una riga pagamenti (es. crash fra create e INSERT).
  // Non e una ricerca storica esaustiva oltre gli ultimi 100 PI.
  const recent = await stripe.paymentIntents.list({ limit: 100 });
  const tagged = recent.data.filter(pi =>
    String(pi.metadata?.test_run || '').startsWith(MARKER) ||
    String(pi.description || '').startsWith(MARKER)
  );
  console.log(`\nPaymentIntent Stripe marcati fra gli ultimi 100: ${tagged.length}`);
  for (const pi of tagged) {
    const db = await pool.query(`
      SELECT id, corsa_id, stato FROM public.pagamenti WHERE stripe_payment_intent=$1 LIMIT 5
    `, [pi.id]);
    const linked = db.rows.length ? db.rows.map(x => `${x.id}/corsa:${x.corsa_id}/${x.stato}`).join(', ') : 'NESSUN PAGAMENTO DB';
    console.log(`PI ${pi.id} | ${pi.status} | ${money(pi.amount)} | capturable=${money(pi.amount_capturable)} | received=${money(pi.amount_received)} | ${linked}`);
  }
  console.log('\nAUDIT CONCLUSO (nessuna modifica).');
  console.log('NOTA: la scansione Stripe copre solo gli ultimi 100 PaymentIntent; se servono dati piu vecchi, estendere la paginazione.');
  if (errors) { console.log(`AVVISI/ERRORI LETTURA: ${errors}`); process.exitCode = 1; }
} catch (err) {
  console.error('AUDIT FALLITO:', err.code || err.type || err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
