// Turentu POPBUS V2 - Test 5C: recupero di job processing abbandonati.
// DRY_RUN default. RUN richiede autorizzazioni esplicite, backup e worker sospesi.
// Nessuna capture; solo Stripe TEST. Un arresto improvviso puo' lasciare fixture.
// Il test NON prova l'esistenza di un worker automatico di riconciliazione.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { pool } from '../db/db.js';
import { riconciliaRiservaPopbus } from '../services/popbus/v2/reservation-reconciliation.service.js';
import {
  riservaPostiPopbus, collegaPaymentIntentPopbus,
  confermaPrenotazionePopbus
} from '../services/popbus/v2/confirmed-booking.service.js';

const RUN = process.env.POPBUS_TEST_MODE === 'RUN';
const VEICOLO_ID = 347;
const CLIENTE_ID = Number(process.env.POPBUS_TEST_CLIENTE_ID || 0);
let MARKER = `TST_POPBUS_RECON_5C_${randomUUID()}`;
let created = { corsa:null, attivazione:null, riserva:null, requestId:null, pi:null };
let stripe;
let stripeCleanupOK = false;
let dbCleanupOK = false;
const log = (...args) => console.log('[POPBUS 5C]', ...args);

async function prerequisites() {
  const {rows:[db]} = await pool.query('SELECT current_database() AS db,current_user AS usr');
  log('DB:',db.db,'utente:',db.usr,'modalita:',RUN?'RUN':'DRY_RUN');
  assert.equal(db.db,'corse_db','STOP: database inatteso');
  const {rows:[v]} = await pool.query(`
    SELECT v.id,v.driver_id,v.posti_totali FROM public.veicolo v
    JOIN public.utente u ON u.id=v.driver_id WHERE v.id=$1`,[VEICOLO_ID]);
  assert(v && Number(v.posti_totali)===4 && Number(v.driver_id)===2,'STOP: veicolo non conforme');
  const {rows:[u]} = await pool.query('SELECT id FROM public.utente WHERE id=$1',[CLIENTE_ID]);
  assert(u,'STOP: cliente test inesistente');
  if (RUN) {
    assert.equal(process.env.POPBUS_TEST_ALLOW_PRODUCTION,'YES','STOP: produzione non autorizzata');
    assert.equal(process.env.POPBUS_TEST_WORKERS_STOPPED,'YES','STOP: worker non dichiarati sospesi');
    assert.equal(process.env.POPBUS_TEST_BACKUP_DONE,'YES','STOP: backup non dichiarato verificato');
    assert.equal(process.env.POPBUS_RECON_ENABLED,'YES','STOP: riconciliazione non abilitata esplicitamente');
    assert.equal(process.env.POPBUS_RECON_APPROVED,'YES','STOP: riconciliazione non approvata esplicitamente');
    assert.equal(process.env.POPBUS_TEST_5C_ACK,'YES','STOP: consenso test 5C mancante');
    assert((process.env.STRIPE_SECRET_KEY||'').startsWith('sk_test_'),'STOP: Stripe non TEST');
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY,{apiVersion:'2022-11-15'});
  }
  const {rows:[table]}=await pool.query("SELECT to_regclass('public.popbus_payment_reconciliation') AS name");
  assert(table.name,'STOP: tabella riconciliazione assente');
  log('Prerequisiti OK. Veicolo:',VEICOLO_ID,'cliente:',CLIENTE_ID);
}

async function fixture() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    const start = new Date(Date.now()+30*86400000);
    const end = new Date(start.getTime()+60*60000);
    const {rows:[c]} = await client.query(`
      INSERT INTO public.corse
      (veicolo_id,start_datetime,arrivo_datetime,tipo_corsa,stato,posti_totali,
       posti_disponibili,posti_prenotati,origine_address,destinazione_address)
      VALUES ($1,$2,$3,'riempimento','prenotabile',4,4,0,$4,$4)
      RETURNING id`,[VEICOLO_ID,start,end,MARKER]);
    created.corsa=c.id;
    const {rows:[a]} = await client.query(`
      INSERT INTO public.popbus_attivazioni
      (veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,corsa_id,expires_at)
      VALUES ($1,$2,'confermata',$3,$4,0,0,0,$5::jsonb,$6,$7)
      RETURNING id`,[VEICOLO_ID,2,start,end,JSON.stringify({test:MARKER}),c.id,end]);
    created.attivazione=a.id;
    await client.query('COMMIT');
    log('FIXTURE COMMITTED:',JSON.stringify(created),'marker:',MARKER);
  } catch(e) {await client.query('ROLLBACK').catch(()=>{});throw e;}
  finally {client.release();}
}

async function inspect() {
  const {rows:[r]} = await pool.query(`
    SELECT r.id,r.request_id,r.corsa_id,r.cliente_id,r.stato,r.expires_at,
           r.created_at,r.payment_intent_id,r.prenotazione_id,
           (SELECT COUNT(*)::int FROM public.prenotazioni WHERE corsa_id=$2) AS bookings,
           (SELECT COUNT(*)::int FROM public.pagamenti WHERE corsa_id=$2) AS payments
    FROM public.popbus_riserve r WHERE r.id=$1 AND r.corsa_id=$2`,
    [created.riserva,created.corsa]);
  assert(r,'STOP: riserva test non trovata');
  return r;
}

async function test(scenario) {
  created.requestId=randomUUID();
  const r=await riservaPostiPopbus({
    requestId:created.requestId,corsaId:created.corsa,clienteId:CLIENTE_ID,
    postiRichiesti:3,startOffset:0,endOffset:10000,
    startIndexPolyline:0,endIndexPolyline:1,prezzo:1.00
  });
  created.riserva=r.id;
  log(scenario,'riserva sintetica:',r.id);

  const pi=await stripe.paymentIntents.create({
    amount:100,currency:'eur',capture_method:'manual',
    payment_method_types:['card'],payment_method:'pm_card_visa',confirm:true,
    metadata:{tipo:'popbus_confirmed',riservaId:String(r.id),
      corsaId:String(created.corsa),clienteId:String(CLIENTE_ID),
      requestId:String(created.requestId),testMarker:MARKER}
  },{idempotencyKey:`turentu-recon-5c-${created.requestId}`});
  created.pi=pi.id;
  assert.equal(pi.livemode,false);
  assert.equal(pi.status,'requires_capture');
  assert.equal(pi.amount_capturable,100);
  log(scenario,'Stripe TEST PI:',pi.id,'stato:',pi.status);
  await collegaPaymentIntentPopbus({riservaId:r.id,clienteId:CLIENTE_ID,paymentIntentId:pi.id});
  let row=await inspect();
  assert.equal(row.payment_intent_id,pi.id);
  assert.equal(row.bookings,0);
  assert.equal(row.payments,0);

  // Simulazione del crash: SOLO fixture test, nessun processo viene terminato.
  // La riserva diventa scaduta e un job risulta abbandonato da oltre 5 minuti.
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    const {rowCount:expired}=await db.query(`UPDATE public.popbus_riserve
      SET stato='scaduta',created_at=NOW()-INTERVAL '31 minutes',
          expires_at=NOW()-INTERVAL '7 minutes',updated_at=NOW()
      WHERE id=$1 AND corsa_id=$2 AND cliente_id=$3 AND request_id=$4
        AND stato='riservata' AND prenotazione_id IS NULL AND payment_intent_id=$5`,
      [r.id,created.corsa,CLIENTE_ID,created.requestId,pi.id]);
    assert.equal(expired,1,'STOP: scadenza fixture non applicata');
    const {rows:[job]}=await db.query(`INSERT INTO public.popbus_payment_reconciliation
      (riserva_id,payment_intent_id,stato,tentativi,claimed_at)
      VALUES ($1,$2,'processing',1,NOW()-INTERVAL '6 minutes')
      RETURNING id,stato,tentativi,claimed_at`,[r.id,pi.id]);
    assert(job && job.stato==='processing' && Number(job.tentativi)===1);
    await db.query('COMMIT');
  } catch(error) { await db.query('ROLLBACK').catch(()=>{}); throw error; }
  finally {db.release();}

  if (scenario==='5C-B') {
    // Il crash avviene DOPO la cancellazione Stripe ma PRIMA del finish DB.
    const canceled=await stripe.paymentIntents.cancel(pi.id,{},
      {idempotencyKey:`turentu-recon-cancel-${r.id}`});
    assert.equal(canceled.status,'canceled');
  }

  const expectedStripe=scenario==='5C-A'?'requires_capture':'canceled';
  const before=await stripe.paymentIntents.retrieve(pi.id);
  assert.equal(before.status,expectedStripe);
  const {rows:[initial]}=await pool.query(`SELECT stato,tentativi,claimed_at
    FROM public.popbus_payment_reconciliation WHERE riserva_id=$1`,[r.id]);
  assert.equal(initial.stato,'processing');
  assert.equal(Number(initial.tentativi),1);
  assert(Date.now()-new Date(initial.claimed_at).getTime() >= 300000,
    'STOP: claim non sufficientemente vecchio');

  // DRY_RUN puntuale: nessuna modifica a job o Stripe.
  const dry=await riconciliaRiservaPopbus(r.id,{dryRun:true});
  assert.equal(dry.eleggibile,true);
  const {rows:[afterDry]}=await pool.query(`SELECT stato,tentativi,claimed_at
    FROM public.popbus_payment_reconciliation WHERE riserva_id=$1`,[r.id]);
  assert.equal(afterDry.stato,'processing');
  assert.equal(Number(afterDry.tentativi),1);
  assert.equal(new Date(afterDry.claimed_at).getTime(),new Date(initial.claimed_at).getTime());
  assert.equal((await stripe.paymentIntents.retrieve(pi.id)).status,expectedStripe);

  // Verifica che il selettore batch identificherebbe questa fixture,
  // senza mai invocare il batch RUN.
  const {rows:[eligible]}=await pool.query(`SELECT r.id FROM public.popbus_riserve r
    JOIN public.popbus_payment_reconciliation j ON j.riserva_id=r.id
    WHERE r.id=$1 AND r.corsa_id=$2 AND r.payment_intent_id=$3
      AND r.prenotazione_id IS NULL AND r.stato='scaduta'
      AND j.stato='processing'
      AND j.claimed_at < NOW()-INTERVAL '5 minutes'`,
    [r.id,created.corsa,pi.id]);
  assert(eligible,'STOP: job non selezionabile per recupero');
  log(scenario,'DRY_RUN e selezione stale PASS');

  const outcome=await riconciliaRiservaPopbus(r.id,{dryRun:false});
  const expected=scenario==='5C-A'?'canceled':'already_canceled_stripe';
  assert.equal(outcome.outcome,expected,`STOP: esito recupero ${scenario} inatteso`);
  const remote=await stripe.paymentIntents.retrieve(pi.id);
  assert.equal(remote.status,'canceled');
  row=await inspect();
  assert.equal(row.stato,'scaduta');
  assert.equal(row.prenotazione_id,null);
  assert.equal(row.bookings,0);
  assert.equal(row.payments,0);
  const {rows:[finalJob]}=await pool.query(`SELECT stato,tentativi,claimed_at,payment_intent_id
    FROM public.popbus_payment_reconciliation WHERE riserva_id=$1`,[r.id]);
  assert.equal(finalJob.stato,'canceled');
  assert.equal(Number(finalJob.tentativi),2,'STOP: tentativi finali diversi da 2');
  assert.equal(finalJob.claimed_at,null);
  assert.equal(finalJob.payment_intent_id,pi.id);
  const again=await riconciliaRiservaPopbus(r.id,{dryRun:false});
  assert.equal(again.outcome,'already_canceled');
  const {rows:[idempotent]}=await pool.query(`SELECT stato,tentativi
    FROM public.popbus_payment_reconciliation WHERE riserva_id=$1`,[r.id]);
  assert.equal(idempotent.stato,'canceled');
  assert.equal(Number(idempotent.tentativi),2);
  let refused=false;
  try {await confermaPrenotazionePopbus({riservaId:r.id,clienteId:CLIENTE_ID});}
  catch(error) {refused=true;log(scenario,'conferma rifiutata:',error.message);}
  assert(refused,'STOP: conferma di riserva scaduta accettata');
  log('PASS',scenario,': recupero',expected,', tentativi 2, idempotenza, nessuna prenotazione');
}

async function cleanupStripe() {
  if (!created.pi) {stripeCleanupOK=true;return;}
  const pi=await stripe.paymentIntents.retrieve(created.pi);
  assert.equal(pi.livemode,false,'STOP PULIZIA: Stripe LIVE');
  assert.equal(pi.metadata?.testMarker,MARKER,'STOP PULIZIA: marker Stripe inatteso');
  assert.equal(pi.metadata?.riservaId,String(created.riserva),'STOP PULIZIA: riserva Stripe inattesa');
  if (['requires_capture','requires_payment_method','requires_confirmation','requires_action','processing'].includes(pi.status)) {
    const canceled=await stripe.paymentIntents.cancel(pi.id);
    assert.equal(canceled.status,'canceled','STOP: Stripe non cancellato');
  } else {
    assert.equal(pi.status,'canceled',`STOP: stato Stripe non cancellabile: ${pi.status}`);
  }
  const verified=await stripe.paymentIntents.retrieve(pi.id);
  assert.equal(verified.status,'canceled','STOP: annullamento Stripe non verificato');
  stripeCleanupOK=true;
  log('PULIZIA STRIPE TEST OK:',pi.id,'stato:',verified.status);
}

async function cleanupDb() {
  if (!created.corsa) {dbCleanupOK=true;return;}
  // Evitare di cancellare il riferimento DB prima di aver verificato
  // l'annullamento Stripe, se il PI e' stato creato.
  if (created.pi && !stripeCleanupOK) throw new Error('STOP PULIZIA DB: Stripe non riconciliato');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    const {rows:[c]}=await client.query(`SELECT id FROM public.corse
      WHERE id=$1 AND origine_address=$2 FOR UPDATE`,[created.corsa,MARKER]);
    assert(c,'STOP PULIZIA: marker corsa inatteso');
    const {rows:acts}=await client.query(`SELECT id FROM public.popbus_attivazioni
      WHERE corsa_id=$1 FOR UPDATE`,[created.corsa]);
    assert.equal(acts.length,1,'STOP PULIZIA: attivazioni inattese');
    assert.equal(String(acts[0].id),String(created.attivazione));
    const {rows:reserves}=await client.query(`SELECT * FROM public.popbus_riserve
      WHERE corsa_id=$1 FOR UPDATE`,[created.corsa]);
    assert.equal(reserves.length,created.riserva?1:0,'STOP PULIZIA: numero riserve inatteso');
    for(const r of reserves) {
      assert.equal(String(r.id),String(created.riserva));
      assert.equal(String(r.request_id),String(created.requestId));
      assert.equal(Number(r.cliente_id),CLIENTE_ID);
      assert.equal(r.prenotazione_id,null);
      assert.equal(r.payment_intent_id,created.pi);
    }
    const {rows:[counts]}=await client.query(`SELECT
      (SELECT COUNT(*)::int FROM public.prenotazioni WHERE corsa_id=$1) AS bookings,
      (SELECT COUNT(*)::int FROM public.pagamenti WHERE corsa_id=$1) AS payments`,[created.corsa]);
    assert.deepEqual(counts,{bookings:0,payments:0},'STOP PULIZIA: prenotazioni/pagamenti presenti');
    for(const r of reserves) {
      const {rows:jobs}=await client.query(`SELECT id,payment_intent_id,stato
        FROM public.popbus_payment_reconciliation WHERE riserva_id=$1 FOR UPDATE`,[r.id]);
      for (const j of jobs) {
        assert.equal(j.payment_intent_id,created.pi,'STOP: job Stripe inatteso');
        assert.equal(j.stato,'canceled','STOP: job non riconciliato');
        const deleted=await client.query(`DELETE FROM public.popbus_payment_reconciliation
          WHERE id=$1 AND riserva_id=$2 AND payment_intent_id=$3 RETURNING id`,
          [j.id,r.id,created.pi]);
        assert.equal(deleted.rowCount,1);
      }
      const d=await client.query(`DELETE FROM public.popbus_riserve
        WHERE id=$1 AND corsa_id=$2 AND request_id=$3 AND prenotazione_id IS NULL
        AND payment_intent_id IS NOT DISTINCT FROM $4 RETURNING id`,
        [r.id,created.corsa,created.requestId,created.pi]);
      assert.equal(d.rowCount,1);
    }
    const a=await client.query(`DELETE FROM public.popbus_attivazioni
      WHERE id=$1 AND corsa_id=$2 RETURNING id`,[created.attivazione,created.corsa]);
    assert.equal(a.rowCount,1);
    const d=await client.query(`DELETE FROM public.corse
      WHERE id=$1 AND origine_address=$2 RETURNING id`,[created.corsa,MARKER]);
    assert.equal(d.rowCount,1);
    await client.query('COMMIT');
    dbCleanupOK=true;
    log('PULIZIA DB OK: corsa',created.corsa,'riserve',reserves.length);
  } catch(e) {await client.query('ROLLBACK').catch(()=>{});throw e;}
  finally {client.release();}
}

try {
  await prerequisites();
  if (!RUN) {
    log('DRY_RUN OK: soli prerequisiti; nessuna scrittura e nessuna chiamata Stripe.');
  } else {
    for (const scenario of ['5C-A','5C-B']) {
      MARKER=`TST_POPBUS_RECON_5C_${randomUUID()}`;
      created={corsa:null,attivazione:null,riserva:null,requestId:null,pi:null};
      stripeCleanupOK=false;
      dbCleanupOK=false;
      let scenarioOK=false;
      try {
        await fixture();
        await test(scenario);
        scenarioOK=true;
      } catch(error) {
        process.exitCode=1;
        console.error('[POPBUS 5C] TEST FALLITO',scenario,':',error);
      } finally {
        try {await cleanupStripe();}
        catch(error) {process.exitCode=1;console.error('[POPBUS 5C] PULIZIA STRIPE FALLITA:',error);}
        try {await cleanupDb();}
        catch(error) {process.exitCode=1;console.error('[POPBUS 5C] PULIZIA DB FALLITA:',error);}
        if (!stripeCleanupOK || !dbCleanupOK) {
          process.exitCode=1;
          console.error('[POPBUS 5C] VERIFICA MANUALE NECESSARIA:',JSON.stringify(created),'marker:',MARKER);
        }
      }
      if (!scenarioOK || !stripeCleanupOK || !dbCleanupOK) break;
    }
    if (!process.exitCode) log('PASS 5C COMPLETO: 5C-A e 5C-B, cleanup verificati');
  }
} catch(error) {
  process.exitCode=1;
  console.error('[POPBUS 5C] PREREQUISITI FALLITI:',error);
} finally {
  await pool.end();
}
