// POPBUS V2 5D: test R3 reale con dipendenze in memoria. NESSUNA rete/DB/Stripe.
// Avvio: node --experimental-vm-modules tests/popbus-riconciliazione-5d.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const source = readFileSync(new URL('../services/popbus/v2/reservation-reconciliation.service.js', import.meta.url), 'utf8');
const now = () => Date.now();
const older = ms => new Date(now() - ms);
const future = ms => new Date(now() + ms);
const log = (...x) => console.log('[POPBUS 5D]', ...x);

async function scenario(name, setup, exercise) {
  const state = {
    reserve: {id: 991001, corsa_id: 991002, cliente_id: 991003, request_id:'5d-request', stato:'scaduta',
      prezzo:'1.00', payment_intent_id:'pi_5d_fake', prenotazione_id:null, expires_at:older(60000)},
    job: null, jobSeq:1, pi: {id:'pi_5d_fake', livemode:false, currency:'eur', capture_method:'manual',
      amount:100, status:'requires_capture', metadata:{tipo:'popbus_confirmed',riservaId:'991001',
        corsaId:'991002',clienteId:'991003',requestId:'5d-request'}},
    stripeRetrieve:0, stripeCancel:0, stripeError:null, finishFail:0, lock:false,
    guardLocks:0, unlocks:0, queries:[], cancelKeys:[], stripeCalls:0
  };
  const pool = {
    async connect() {
      let sessionLock = false;
      return {
        async query(sql, args=[]) {
          if (/pg_try_advisory_lock/i.test(sql)) {
            if (state.lock) return {rows:[{acquired:false}]};
            state.lock=true; sessionLock=true; state.guardLocks++;
            return {rows:[{acquired:true}]};
          }
          if (/pg_advisory_unlock/i.test(sql)) {
            assert(sessionLock); state.lock=false; sessionLock=false; state.unlocks++;
            return {rows:[{pg_advisory_unlock:true}]};
          }
          return query(sql,args);
        },
        release() { if(sessionLock) { state.lock=false; sessionLock=false; } }
      };
    },
    query
  };
  async function query(sql,args=[]) {
    state.queries.push(sql);
    const s = sql.replace(/\s+/g,' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/i.test(s)) return {rows:[],rowCount:0};
    if (/SELECT corsa_id FROM public\.popbus_riserve/i.test(s)) return {rows:[{corsa_id:state.reserve.corsa_id}]};
    if (/SELECT id FROM public\.corse/i.test(s)) return {rows:[{id:state.reserve.corsa_id}]};
    if (/SELECT \* FROM public\.popbus_riserve/i.test(s)) return {rows:[{...state.reserve}]};
    if (/UPDATE public\.popbus_riserve SET stato='scaduta'/i.test(s)) {state.reserve.stato='scaduta';return {rowCount:1,rows:[]};}
    if (/INSERT INTO public\.popbus_payment_reconciliation/i.test(s)) {
      if (!state.job) state.job={id:state.jobSeq,riserva_id:state.reserve.id,payment_intent_id:state.reserve.payment_intent_id,
        stato:'pending',tentativi:0,claimed_at:null,prossimo_tentativo_at:null,ultimo_errore:null};
      return {rowCount:1,rows:[]};
    }
    if (/SELECT \* FROM public\.popbus_payment_reconciliation/i.test(s)) return {rows:state.job?[{...state.job}]:[]};
    if (/UPDATE public\.popbus_payment_reconciliation SET stato='processing'/i.test(s)) {
      state.job.stato='processing';state.job.claimed_at=new Date();state.job.tentativi++;
      state.job.ultimo_errore=null;return {rows:[{tentativi:state.job.tentativi}],rowCount:1};
    }
    if (/UPDATE public\.popbus_payment_reconciliation SET stato=\$2::varchar/i.test(s)) {
      if (state.finishFail>0) {state.finishFail--;throw Error('SIMULATED_DB_WRITE_FAILURE');}
      const [id,status,message,backoff,attempt]=args;
      if(state.job.id!==id || state.job.stato!=='processing' || state.job.tentativi!==attempt)
        return {rowCount:0,rows:[]};
      state.job.stato=status;state.job.ultimo_errore=message;state.job.claimed_at=null;
      state.job.prossimo_tentativo_at=status==='retry'?future(backoff*60000):null;
      return {rowCount:1,rows:[]};
    }
    if (/SELECT id, corsa_id, stato, expires_at/i.test(s)) return {rows:[{...state.reserve}]};
    throw Error('Query SQL non simulata: '+s.slice(0,160));
  }
  class FakeStripe {
    constructor(key) {assert(key.startsWith('sk_test_'));}
    paymentIntents = {
      retrieve: async id => {
        state.stripeRetrieve++;assert.equal(id,state.pi.id);
        if(state.stripeError==='retrieve') throw Error('SIMULATED_STRIPE_TIMEOUT');
        return {...state.pi,metadata:{...state.pi.metadata}};
      },
      cancel: async (id,params,opts) => {
        state.stripeCancel++;assert.equal(id,state.pi.id);
        state.cancelKeys.push(opts?.idempotencyKey);
        if(state.stripeError==='cancel') throw Error('SIMULATED_STRIPE_503');
        state.pi.status='canceled';return {...state.pi};
      }
    };
  }
  const context=createContext({process:{env:{STRIPE_SECRET_KEY:'sk_test_5d_fake',POPBUS_RECON_ENABLED:'YES',POPBUS_RECON_APPROVED:'YES'}},
    Date,Math,Number,String,Error,console});
  const mod=new SourceTextModule(source,{context,identifier:'isolated-R3.js'});
  const stripeMod=new SyntheticModule(['default'],function(){this.setExport('default',FakeStripe);},{context});
  const dbMod=new SyntheticModule(['pool'],function(){this.setExport('pool',pool);},{context});
  await mod.link(spec => {
    if(spec==='stripe') return stripeMod;
    if(spec==='../../../db/db.js') return dbMod;
    throw Error('Import inatteso: '+spec);
  });
  await mod.evaluate();
  const reconcile=mod.namespace.riconciliaRiservaPopbus;
  await setup(state);
  try { await exercise(state,reconcile); assert.equal(state.lock,false); assert.equal(state.guardLocks,state.unlocks);log('PASS',name); }
  catch(err) {log('FAIL',name,err.message);throw err;}
}

await scenario('5D-A: timeout Stripe -> retry e 60 minuti',s=>{s.stripeError='retrieve';},async(s,reconcile)=>{
  await assert.rejects(()=>reconcile(s.reserve.id,{dryRun:false}),/SIMULATED_STRIPE_TIMEOUT/);
  assert.equal(s.job.stato,'retry');assert.equal(s.job.tentativi,1);
  assert(s.job.prossimo_tentativo_at.getTime()-now()>59*60000);
  const blocked=await reconcile(s.reserve.id,{dryRun:false});assert.equal(blocked.outcome,'backoff');
  assert.equal(s.stripeRetrieve,1);assert.equal(s.stripeCancel,0);
});
await scenario('5D-B: errore cancel -> backoff -> recupero',s=>{s.stripeError='cancel';},async(s,reconcile)=>{
  await assert.rejects(()=>reconcile(s.reserve.id,{dryRun:false}),/SIMULATED_STRIPE_503/);
  assert.equal(s.job.stato,'retry');assert.equal(s.stripeCancel,1);
  s.job.prossimo_tentativo_at=older(1000);s.stripeError=null;
  const result=await reconcile(s.reserve.id,{dryRun:false});assert.equal(result.outcome,'canceled');
  assert.equal(s.job.stato,'canceled');assert.equal(s.job.tentativi,2);
  assert.deepEqual(s.cancelKeys,['popbus-recon-cancel-991001','popbus-recon-cancel-991001']);
});
await scenario('5D-C: DB finish fallisce dopo Stripe canceled',s=>{s.finishFail=2;},async(s,reconcile)=>{
  await assert.rejects(()=>reconcile(s.reserve.id,{dryRun:false}),/SIMULATED_DB_WRITE_FAILURE/);
  assert.equal(s.pi.status,'canceled');assert.equal(s.job.stato,'processing');assert.equal(s.job.tentativi,1);
  s.job.claimed_at=older(6*60000);
  const result=await reconcile(s.reserve.id,{dryRun:false});
  assert.equal(result.outcome,'already_canceled_stripe');assert.equal(s.job.stato,'canceled');
  assert.equal(s.job.tentativi,2);assert.equal(s.stripeCancel,1);
});
await scenario('5D-D: PI identita non valida -> manual_review',s=>{s.pi.amount=999;},async(s,reconcile)=>{
  const result=await reconcile(s.reserve.id,{dryRun:false});
  assert.equal(result.outcome,'manual_review');assert.equal(s.job.stato,'manual_review');
  assert.equal(s.stripeCancel,0);
});
await scenario('5D-E: lock gia occupato -> busy',s=>{s.lock=true;},async(s,reconcile)=>{
  const result=await reconcile(s.reserve.id,{dryRun:false});
  assert.equal(result.outcome,'busy');assert.equal(s.job,null);assert.equal(s.stripeRetrieve,0);
  s.lock=false;
});
log('PASS COMPLETO 5D: nessuna connessione esterna, nessuna scrittura reale');
