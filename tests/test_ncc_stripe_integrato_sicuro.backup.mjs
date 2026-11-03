// TURENTU NCC â€” INTEGRAZIONE REALE POSTGRESQL + STRIPE TEST
// Salva come tests/test_ncc_stripe_integrato_reale.mjs
// Esegui: node tests/test_ncc_stripe_integrato_reale.mjs
// ATTENZIONE: scrive su PostgreSQL e crea/cattura pagamenti Stripe TEST.
// NON usare su database operativo. Usa SOLO sk_test_.
// Scenari: 1) cattura A+B+C; 2) A gia catturato, riconcilia e cattura B+C.
// Su errore mantiene i record per diagnosi/ripresa. Non cancella oggetti Stripe.
import 'dotenv/config';
import Stripe from 'stripe';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../db/db.js';
import { toggleCorsa } from '../services/corsa/corse.service.js';

const key = process.env.STRIPE_SECRET_KEY || '';
if (!key.startsWith('sk_test_')) throw new Error('BLOCCO: richiede STRIPE_SECRET_KEY sk_test_');
if (process.env.TURENTU_ALLOW_INTEGRATION_DB_WRITE !== 'YES') {
  throw new Error('BLOCCO: imposta TURENTU_ALLOW_INTEGRATION_DB_WRITE=YES solo per esecuzione autorizzata');
}
const stripe = new Stripe(key);
const runId = `TURENTU_NCC_STRIPE_TEST_${Date.now()}_${process.pid}`;
const journalPath = join(process.cwd(), 'tests', runId + '.journal.json');
const passengers = [
  { label: 'A', km: 100, start: 0, end: 100000, authorized: 6765, due: 3075 },
  { label: 'B', km: 60, start: 20000, end: 80000, authorized: 2537, due: 1845 },
  { label: 'C', km: 60, start: 40000, end: 100000, authorized: 1845, due: 1845 },
];
let pass = 0;
const fixtures = [];
function saveJournal() {
  const data = { runId, updatedAt: new Date().toISOString(), fixtures };
  writeFileSync(journalPath + '.tmp', JSON.stringify(data, null, 2)); renameSync(journalPath + '.tmp', journalPath);
}
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
  saveJournal();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='5s'");
    const v = await c.query(
  `SELECT id, posti_totali
   FROM public.veicolo
   WHERE id = 357
     AND driver_id = 2
     AND stato = 'test'
     AND posti_totali >= 3`
);
    if (!v.rows.length) throw new Error('Veicolo TEST 357 non disponibile: nessuna scrittura consentita');
    const u = await c.query(`INSERT INTO public.utente (nome,email,tipo,password) SELECT $1 || n, $2 || n || chr(64) || 'example.invalid', 'cliente', $3 FROM generate_series(1,3) AS n RETURNING id`, [marker, marker.toLowerCase(), 'DISABLED_TEST_ACCOUNT_' + marker]); fixture.userIds = u.rows.map(x => x.id);
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
    // Il Modello A richiede il prezzo fisso e la prenotazione origine.
    // Senza questo aggiornamento toggleCorsa ricadrebbe nel pricing legacy.
    if (fixture.items.length !== 3 || !fixture.items[0]?.prenId) {
      throw new Error('Fixture incompleta: prenotazione origine mancante');
    }
    await c.query(
      `UPDATE public.corse SET prenotazione_origine_id = $1 WHERE id = $2`,
      [fixture.items[0].prenId, fixture.rideId]
    );
    saveJournal();
    await c.query('COMMIT');
    fixture.dbCommitted = true;
    saveJournal();
    console.log(`FIXTURE ${scenario}: corsa=${fixture.rideId} tratta=${fixture.trattaId} marker=${marker}`);
  } catch(e) {
    await c.query('ROLLBACK').catch(()=>{});
    throw e;
  } finally { c.release(); }

  // Ogni PI viene confermato in Stripe TEST con carta simulata, cattura manuale.
  for (const item of fixture.items) {
    item.stripeCreateKey = `${marker}_create_${item.label}`;
    item.stripeCreatePending = true;
    saveJournal();
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
    item.stripeCreatePending = false;
    saveJournal();
    check(pi.livemode === false && pi.status === 'requires_capture' && pi.amount_capturable >= item.due,
      `${scenario}/${item.label}: autorizzazione Stripe TEST ${item.authorized} cent`);
    const inserted = await pool.query(`
      INSERT INTO public.pagamenti
      (prenotazione_id,corsa_id,importo,stato,stripe_payment_intent,tipo_corsa,currency)
      VALUES ($1,$2,$3,'autorizzazione',$4,'condivisa','eur') RETURNING id`,
      [item.prenId, fixture.rideId, item.authorized/100, pi.id]);
    item.paymentId = inserted.rows[0].id;
    saveJournal();
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
  saveJournal();
}
async function cleanup(f) {
  // Cancella esclusivamente le fixture marcate dal test, in ordine FK.
  // Se uno scenario non e completo, preserva i dati per riconciliazione.
  if (!f.complete) return;
  if (!Array.isArray(f.userIds) || f.userIds.length !== 3 || new Set(f.userIds).size !== 3) throw new Error('CLEANUP BLOCCATO: clienti sintetici non identificati');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ride = await c.query('SELECT origine_address FROM public.corse WHERE id=$1 FOR UPDATE',[f.rideId]);
    if (ride.rows[0]?.origine_address !== f.marker) throw new Error('Marker differente: pulizia bloccata');
    const users = await c.query('SELECT id FROM public.utente WHERE id = ANY($1::int[]) AND tipo=$2 AND nome LIKE $3', [f.userIds, 'cliente', f.marker + '%']);
    if (users.rows.length !== 3) throw new Error('CLEANUP BLOCCATO: identita clienti TEST non verificata');
    const dependencies = await c.query('SELECT (SELECT concat_ws(chr(46), n.nspname, cl.relname) FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE cl.oid=pc.conrelid) AS tabella, a.attname AS colonna FROM pg_constraint pc JOIN LATERAL unnest(pc.conkey) AS k(attnum) ON true JOIN pg_attribute a ON a.attrelid=pc.conrelid AND a.attnum=k.attnum WHERE pc.contype=$1 AND pc.confrelid=$2::regclass', ['f', 'public.utente']);
    for (const dep of dependencies.rows) { const q = x => String.fromCharCode(34) + x.replaceAll(String.fromCharCode(34), String.fromCharCode(34,34)) + String.fromCharCode(34); const table = dep.tabella.split('.').map(q).join('.'); const column = q(dep.colonna); const r = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = ANY($1::int[])`, [f.userIds]); if (r.rows[0].n > 0 && !(dep.tabella.split('.').pop() === 'prenotazioni' && dep.colonna === 'cliente_id' && r.rows[0].n === 3)) throw new Error(`CLEANUP BLOCCATO: riferimenti in ${dep.tabella}.${dep.colonna}`); }
    const bookings = await c.query('SELECT id, cliente_id FROM public.prenotazioni WHERE cliente_id = ANY($1::int[]) FOR UPDATE', [f.userIds]); if (bookings.rows.length !== 3 || bookings.rows.some(x => !f.items.some(i => Number(i.prenId) === Number(x.id)) || !f.userIds.includes(Number(x.cliente_id)))) throw new Error('CLEANUP BLOCCATO: prenotazioni sintetiche non corrispondenti');
    const payments = await c.query('SELECT id FROM public.pagamenti WHERE corsa_id=$1 FOR UPDATE', [f.rideId]);
    if (payments.rows.length !== 3 || payments.rows.some(x => !f.items.some(i => Number(i.paymentId) === Number(x.id)))) throw new Error('CLEANUP BLOCCATO: pagamenti non corrispondenti alla fixture');
    await c.query('DELETE FROM public.pagamenti WHERE corsa_id=$1',[f.rideId]);
    await c.query('DELETE FROM public.prenotazioni WHERE corsa_id=$1',[f.rideId]);
    await c.query('DELETE FROM public.corse_tratte WHERE corsa_id=$1',[f.rideId]);
    await c.query('DELETE FROM public.corse WHERE id=$1',[f.rideId]);
    const deletedUsers = await c.query('DELETE FROM public.utente WHERE id = ANY($1::int[]) AND tipo=$2 AND nome LIKE $3 RETURNING id', [f.userIds, 'cliente', f.marker + '%']);
    if (deletedUsers.rowCount !== 3) throw new Error('CLEANUP BLOCCATO: numero clienti eliminati non valido');
    await c.query('COMMIT');
    f.cleaned = true;
    saveJournal();
    console.log(`CLEANUP DB OK: corsa ${f.rideId} (PaymentIntent Stripe TEST conservati)`);
  } catch(e) { await c.query('ROLLBACK').catch(()=>{}); console.error(`CLEANUP NON RIUSCITO corsa ${f.rideId}: ${e.message}`); process.exitCode = 1; }
  finally { c.release(); }
}
try {
  console.log(`\nTURENTU NCC - STRIPE TEST + POSTGRESQL REALE\nRUN ${runId}\n`);
  const account = await stripe.accounts.retrieve();
  check(!!account.id, 'Account Stripe TEST raggiungibile');
  const one = await makeFixture('COMPLETA');
  await toggleCorsa(one.rideId,'end');
  await verify(one,'COMPLETA');
// const one = await makeFixture('COMPLETA');
// await toggleCorsa(one.rideId, 'end');
// await verify(one, 'COMPLETA');

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
  for (const f of fixtures) { try { await cleanup(f); } catch (e) { console.error('CLEANUP NON RIUSCITO: ' + e.message); process.exitCode = 1; } }
  await pool.end();
}
