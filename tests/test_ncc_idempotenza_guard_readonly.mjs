// TURENTU - VERIFICA GUARDIA DI CHIUSURA E COERENZA STRIPE (READ ONLY)
// Salva come tests/test_ncc_idempotenza_guard_readonly.mjs
// Avvio: node --env-file=.env tests/test_ncc_idempotenza_guard_readonly.mjs
// NON richiama toggleCorsa; NON esegue capture; NON modifica PostgreSQL.
import Stripe from 'stripe';
import { pool } from '../db/db.js';
import { readFile } from 'node:fs/promises';

const CORSA_ID = 919;
const key = process.env.STRIPE_SECRET_KEY || '';
if (!key.startsWith('sk_test_')) {
  console.error('STOP: STRIPE_SECRET_KEY deve essere sk_test_');
  process.exit(1);
}
const stripe = new Stripe(key, { timeout: 10000, maxNetworkRetries: 0 });
let fail = 0;
function check(label, ok, details='') {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label}${details ? ' | ' + details : ''}`);
  if (!ok) fail++;
}
const cents = value => Math.round(Number(value) * 100);
try {
  console.log('\n=== NCC CORSA 919 - AUDIT IDEMPOTENZA (SOLO LETTURA) ===');
  const ride = await pool.query(`SELECT id, stato, tipo_corsa, prezzo_fisso FROM public.corse WHERE id=$1`, [CORSA_ID]);
  check('Corsa esistente', ride.rowCount === 1);
  if (ride.rowCount !== 1) throw new Error('Corsa 919 non trovata: nessuna azione');
  const c = ride.rows[0];
  check('Corsa completata', c.stato === 'completata', `stato=${c.stato}`);
  check('Modello A condivisa', c.tipo_corsa === 'condivisa' && c.prezzo_fisso !== null);

  const { rows } = await pool.query(`
    SELECT pr.id AS prenotazione_id, pr.prezzo_totale,
           p.id AS pagamento_id, p.importo, p.stato, p.stripe_payment_intent
    FROM public.prenotazioni pr
    LEFT JOIN public.pagamenti p ON p.prenotazione_id=pr.id AND p.corsa_id=pr.corsa_id
    WHERE pr.corsa_id=$1 ORDER BY pr.id, p.id`, [CORSA_ID]);
  const ids = new Set(rows.map(r => r.prenotazione_id));
  check('Tre prenotazioni', ids.size === 3, `trovate=${ids.size}`);
  check('Un pagamento per prenotazione', rows.length === ids.size && rows.every(r => r.pagamento_id !== null));
  const total = rows.reduce((n,r) => n + cents(r.prezzo_totale), 0);
  check('Somma quote = prezzo fisso', total === cents(c.prezzo_fisso), `${total} cent`);
  const paymentIds = rows.map(r => r.stripe_payment_intent).filter(Boolean);
  check('PaymentIntent distinti', paymentIds.length === rows.length && new Set(paymentIds).size === rows.length);
  for (const r of rows) {
    const prefix = `pren=${r.prenotazione_id} pag=${r.pagamento_id}`;
    check(`${prefix} DB pagato`, r.stato === 'pagato');
    check(`${prefix} DB importo corretto`, cents(r.importo) === cents(r.prezzo_totale));
    if (!r.stripe_payment_intent) { check(`${prefix} Stripe ID`, false); continue; }
    const pi = await stripe.paymentIntents.retrieve(r.stripe_payment_intent);
    check(`${prefix} Stripe TEST succeeded`, pi.livemode === false && pi.status === 'succeeded');
    check(`${prefix} Stripe incasso corretto`, pi.amount_received === cents(r.prezzo_totale), `received=${pi.amount_received} cent`);
    check(`${prefix} nulla da catturare`, pi.amount_capturable === 0);
  }
  // Verifica statica: la chiusura non deve poter superare la guardia quando la corsa e completata.
  // Il file del servizio va indicato esplicitamente, per evitare di esaminare una copia sbagliata.
  const sourcePath = process.env.NCC_SERVICE_SOURCE;
  if (sourcePath) {
    const src = await readFile(sourcePath, 'utf8');
    check('Guardia SQL stato in_corso per end (controllo statico)',
      /action\s*===\s*['"]start['"]\s*\?\s*\[[^\]]+\]\s*:\s*\[['"]in_corso['"]\]/.test(src) &&
      /UPDATE\s+public\.corse[\s\S]*?AND\s+stato\s*=\s*ANY\(\$3::varchar\[\]\)/i.test(src));
    console.log('NOTA: il controllo del sorgente e statico, NON equivale a un retry HTTP reale.');
  } else {
    console.log('SKIP | Guardia SQL statica: imposta NCC_SERVICE_SOURCE al file realmente distribuito, se disponibile.');
  }
  console.log(`\nESITO: ${fail === 0 ? 'PASS AUDIT READ ONLY' : `FAIL (${fail})`}`);
  console.log('IMPORTANTE: questo test non dimostra la sicurezza contro crash fra capture Stripe e COMMIT DB.');
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error('ERRORE:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
