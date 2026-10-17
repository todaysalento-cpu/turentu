// TURENTU NCC — INTEGRAZIONE REALE POSTGRESQL + STRIPE TEST
// Salva come tests/test_ncc_stripe_integrato_reale.mjs
// Esegui: node tests/test_ncc_stripe_integrato_reale.mjs
// ATTENZIONE: scrive su PostgreSQL e crea/cattura pagamenti Stripe TEST.
// NON usare su database operativo. Usa SOLO sk_test_.
// Scenari: 1) cattura A+B+C; 2) A gia catturato, riconcilia e cattura B+C.
// Su errore mantiene i record per diagnosi/ripresa. Non cancella oggetti Stripe.
import 'dotenv/config';
import Stripe from 'stripe';
import { pool } from '../db/db.js';
import { toggleCorsa } from '../services/corsa/corse.service.js';

const key = process.env.STRIPE_SECRET_KEY || '';
if (!key.startsWith('sk_test_')) throw new Error('BLOCCO: richiede STRIPE_SECRET_KEY sk_test_');
const stripe = new Stripe(key);
const runId = `TURENTU_NCC_STRIPE_TEST_${Date.now()}_${process.pid}`;
const passengers = [
  { label: 'A', km: 100, start: 0, end: 100000, authorized: 6765, due: 3075 },
  { label: 'B', km: 60, start: 20000, end: 80000, authorized: 2537, due: 1845 },
  { label: 'C', km: 60, start: 40000, end: 100000, authorized: 1845, due: 1845 },
];
let pass = 0;
const fixtures = [];
const check = (condition, name) => {
  if (!condition) throw new Error(`FAIL ${name}`);
  pass++;
  console.log(`PASS ${name}`);
};
async function makeFixture(scenario) {
  const marker = `${runId}_${scenario}`;
  const c = await pool.connect();
  const fixture = { marker, scenario, rideId: null, trattaId: null, items: [], complete: false };
  fixtures.push(fixture);
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='5s'");
    const v = await c.query('SELECT id,posti_totali FROM public.veicolo WHERE posti_totali>=3 ORDER BY id LIMIT 1');
    const u = await c.query('SELECT id FROM public.utente ORDER BY id LIMIT 3');
    if (!v.rows.length || u.rows.length < 3) throw new Error('Mancano veicolo capienza >=3 o tre utenti');
    const depart = new Date(Date.now() + 30 * 86400000);
    const arrival = new Date(depart.getTime() + 2 * 3600000);
    const ride = await c.query(`
      INSERT INTO public.corse
      (veicolo_id,start_datetime,arrivo_datetime,tipo_corsa,stato,posti_totali,
       posti_disponibili,posti_prenotati,distanza,prezzo_fisso,
       km_avvicinamento,km_riposizionamento,origine_address,destinazione_address)
      VALUES ($1,$2,$3,'condivisa','in_corso',$4,$5,3,100,67.65,0,0,$6,'TEST STRIPE DESTINAZIONE')
      RETURNING id`, [v.rows[0].id, depart, arrival, v.rows[0].posti_totali,
        v.rows[0].posti_totali - 3, marker]);
    fixture.rideId = ride.rows[0].id;
    const tr = await c.query(`
      INSERT INTO public.corse_tratte
      (corsa_id,direzione,distanza_km,durata_secondi,partenza_prevista,arrivo_previsto,stato_temporale)
      VALUES ($1,'andata',100,7200,$2,$3,'programmato') RETURNING id`,
      [fixture.rideId, depart, arrival]);
    fixture.trattaId = tr.rows[0].id;
    for (let i=0;i<3;i++) {
      const p = passengers[i];
      const pr = await c.query(`
        INSERT INTO public.prenotazioni
        (corsa_id,cliente_id,posti_prenotati,posti_richiesti,prezzo_totale,
         tratta_id,start_offset,end_offset,km_utente)
        VALUES ($1,$2,1,1,$3,$4,$5,$6,$7) RETURNING id`,
        [fixture.rideId, u.rows[i].id, p.due/100, fixture.trattaId, p.start, p.end, p.km]);
      fixture.items.push({ ...p, prenId: pr.rows[0].id, piId: null, paymentId: null });
    }
    await c.query('COMMIT');
    console.log(`FIXTURE ${scenario}: corsa=${fixture.rideId} tratta=${fixture.trattaId} marker=${marker}`);
  } catch(e) {
    await c.query('ROLLBACK').catch(()=>{});
    throw e;
  } finally { c.release(); }

  // Ogni PI viene confermato in Stripe TEST con carta simulata, cattura manuale.
  for (const item of fixture.items) {
    const pi = await stripe.paymentIntents.create({
      amount: item.authorized,
      currency: 'eur',
      capture_method: 'manual',
      confirm: true,
      payment_method: 'pm_card_visa',
      payment_method_types: ['card'],
      description: `${marker} passeggero ${item.label}`,
      metadata: { test_run: runId, corsa_test_id: String(fixture.rideId), passeggero: item.label },
    }, { idempotencyKey: `${marker}_create_${item.label}` });
    item.piId = pi.id;
    check(pi.livemode === false && pi.status === 'requires_capture' && pi.amount_capturable >= item.due,
      `${scenario}/${item.label}: autorizzazione Stripe TEST ${item.authorized} cent`);
    const inserted = await pool.query(`
      INSERT INTO public.pagamenti
      (prenotazione_id,corsa_id,importo,stato,stripe_payment_intent,tipo_corsa,currency)
      VALUES ($1,$2,$3,'autorizzazione',$4,'condivisa','eur') RETURNING id`,
      [item.prenId, fixture.rideId, item.authorized/100, pi.id]);
    item.paymentId = inserted.rows[0].id;
  }
  return fixture;
}
async function verify(f, label) {
  const r = await pool.query('SELECT stato,prezzo_fisso FROM public.corse WHERE id=$1',[f.rideId]);
  check(r.rows[0]?.stato === 'completata', `${label}: corsa completata`);
  const db = await pool.query('SELECT prenotazione_id,stato,importo FROM public.pagamenti WHERE corsa_id=$1',[f.rideId]);
  check(db.rows.length === 3 && db.rows.every(p=>p.stato==='pagato'), `${label}: tre pagamenti DB pagati`);
  let total = 0;
  for (const item of f.items) {
    const p = db.rows.find(x=>Number(x.prenotazione_id)===item.prenId);
    check(p && Math.round(Number(p.importo)*100) === item.due, `${label}/${item.label}: importo DB ${item.due} cent`);
    const pi = await stripe.paymentIntents.retrieve(item.piId);
    check(pi.livemode === false && pi.status === 'succeeded' && pi.amount_received === item.due,
      `${label}/${item.label}: cattura Stripe ${item.due} cent`);
    total += pi.amount_received;
  }
  check(total === 6765, `${label}: totale catturato 6765 cent`);
  let rejected = false;
  try { await toggleCorsa(f.rideId,'end'); }
  catch(e) { rejected = /Transizione non consentita/.test(e.message); }
  check(rejected, `${label}: seconda chiusura respinta`);
  for (const item of f.items) {
    const pi = await stripe.paymentIntents.retrieve(item.piId);
    check(pi.amount_received === item.due, `${label}/${item.label}: nessuna doppia cattura`);
  }
  f.complete = true;
}
async function cleanup(f) {
  // Cancella esclusivamente le fixture marcate dal test, in ordine FK.
  // Se uno scenario non e completo, preserva i dati per riconciliazione.
  if (!f.complete) return;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ride = await c.query('SELECT origine_address FROM public.corse WHERE id=$1 FOR UPDATE',[f.rideId]);
    if (ride.rows[0]?.origine_address !== f.marker) throw new Error('Marker differente: pulizia bloccata');
    await c.query('DELETE FROM public.pagamenti WHERE corsa_id=$1',[f.rideId]);
    await c.query('DELETE FROM public.prenotazioni WHERE corsa_id=$1',[f.rideId]);
    await c.query('DELETE FROM public.corse_tratte WHERE corsa_id=$1',[f.rideId]);
    await c.query('DELETE FROM public.corse WHERE id=$1',[f.rideId]);
    await c.query('COMMIT');
    console.log(`CLEANUP DB OK: corsa ${f.rideId} (PaymentIntent Stripe TEST conservati)`);
  } catch(e) { await c.query('ROLLBACK').catch(()=>{}); console.error(`CLEANUP NON RIUSCITO corsa ${f.rideId}: ${e.message}`); }
  finally { c.release(); }
}
try {
  console.log(`\nTURENTU NCC - STRIPE TEST + POSTGRESQL REALE\nRUN ${runId}\n`);
  const account = await stripe.accounts.retrieve();
  check(!!account.id, 'Account Stripe TEST raggiungibile');
  const one = await makeFixture('COMPLETA');
  await toggleCorsa(one.rideId,'end');
  await verify(one,'COMPLETA');
  const two = await makeFixture('RICONCILIA');
  // Simula il caso di cattura Stripe riuscita e COMMIT DB non ancora eseguito:
  // A e gia succeeded su Stripe, ma il DB e ancora autorizzazione.
  const a = two.items[0];
  const pre = await stripe.paymentIntents.capture(a.piId, { amount_to_capture: a.due },
    { idempotencyKey: `${two.marker}_pre_capture_A` });
  check(pre.status==='succeeded' && pre.amount_received===a.due,
    'RICONCILIA: A gia catturato su Stripe prima della chiusura');
  const state = await pool.query('SELECT stato FROM public.pagamenti WHERE id=$1',[a.paymentId]);
  check(state.rows[0]?.stato==='autorizzazione', 'RICONCILIA: A ancora autorizzazione nel DB');
  await toggleCorsa(two.rideId,'end');
  await verify(two,'RICONCILIA');
  console.log(`\nRISULTATO: ${pass} PASS / 0 FAIL`);
} catch(e) {
  console.error(`\nFAIL INTEGRAZIONE: ${e.stack || e.message}`);
  process.exitCode = 1;
} finally {
  for (const f of fixtures) {
    console.log(`RIEPILOGO ${f.scenario}: corsa=${f.rideId} marker=${f.marker} complete=${f.complete}`);
    console.log('Stripe PI:', f.items.map(x=>`${x.label}:${x.piId || 'non creato'}`).join(' '));
  }
  for (const f of fixtures) await cleanup(f);
  await pool.end();
}
