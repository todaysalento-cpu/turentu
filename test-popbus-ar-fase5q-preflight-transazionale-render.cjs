'use strict';
// Fase 5Q - fixture sintetica + preflight transazionale REALE su Render.
// NON invoca il finalizzatore, Stripe o servizi esterni. ROLLBACK obbligatorio.
const { Client } = require('pg');
const { randomUUID, randomInt } = require('node:crypto');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const fail = msg => { throw new Error('5Q STOP: ' + msg); };
if (process.env.TURENTU_TEST_AR_CONFIRM !== 'ROLLBACK_ONLY') fail('richiesto TURENTU_TEST_AR_CONFIRM=ROLLBACK_ONLY');
if (!process.env.DATABASE_URL) fail('DATABASE_URL assente');
if (process.env.STRIPE_SECRET_KEY && !/^sk_test_/.test(process.env.STRIPE_SECRET_KEY)) fail('chiave Stripe LIVE presente: interrompere');
const ssl = process.env.TURENTU_RENDER_SSL_DIAGNOSTIC === '1'
  ? { rejectUnauthorized: false } // SOLO diagnostica temporanea, non per produzione applicativa.
  : { rejectUnauthorized: true };
const db = new Client({ connectionString:process.env.DATABASE_URL, ssl, connectionTimeoutMillis:15000, application_name:'turentu_5q_fixture_rollback' });
let tx=false;
const ids = Array.from({length:11}, () => randomInt(1500000000, 2000000000));
if (new Set(ids).size!==ids.length) fail('collisione ID sintetici');
// Il coordinatore richiede ID attivazione interi positivi.
// Gli ID sono sintetici e non avanzano sequenze; eventuali collisioni DB bloccano il test.
const [cliente,reqA,reqR,attA,attR,offA,offR,walletA,walletR,acceptA,acceptR]=ids;
const gid=randomUUID(), rida=randomUUID(), ridr=randomUUID();
const expiry=new Date(Date.now()+60*60*1000).toISOString();
const startA=new Date(Date.now()+48*60*60*1000);
startA.setUTCHours(9,0,0,0);
const endA=new Date(startA.getTime()+60*60*1000);
const startR=new Date(startA.getTime()+4*60*60*1000);
const endR=new Date(startR.getTime()+60*60*1000);
async function q(sql,params=[]){return db.query(sql,params);}
async function main(){
 try {
  await db.connect();
  await q('BEGIN'); tx=true;
  await q("SET LOCAL statement_timeout = '15000ms'");
  await q("SET LOCAL lock_timeout = '2000ms'");
  const ident=await q('SELECT current_database() db, current_user usr');
  if(ident.rows[0].db!=='corse_db') fail('database inatteso: '+ident.rows[0].db);
  const vehicles=await q('SELECT id,driver_id,stato,posti_totali FROM veicolo WHERE id=ANY($1::int[]) ORDER BY id',[[357,358]]);
  if(vehicles.rowCount!==2 || vehicles.rows.some(v=>v.stato!=='test'||Number(v.driver_id)!==2||Number(v.posti_totali)<1)) fail('veicoli 357/358 non sono entrambi test, operatore 2, con posti');
  // Non scriviamo sui veicoli reali, neppure quelli di test.
  await q("INSERT INTO utente(id,nome,email,tipo,password) VALUES ($1,'5Q FIXTURE ROLLBACK',$2,'cliente',$3)", [cliente,`fixture-5q-${randomUUID()}@invalid.example`,'!non-login-fixture!']);
  await q("INSERT INTO ar_gruppi(id,cliente_id,stato,expires_at) VALUES ($1,$2,'pronto',$3)",[gid,cliente,expiry]);
  const requests=[
   {id:reqA,requestId:rida,tratta:'andata',start:startA,from:8,to:7},
   {id:reqR,requestId:ridr,tratta:'ritorno',start:startR,from:7,to:8}
  ];
  for(const [index,r] of requests.entries()){
   await q(`INSERT INTO richieste_pop_bus(id,cliente_id,start_datetime,posti_richiesti,stato,classe,prezzo,payment_intent_id,request_id,ar_group_id,ar_tratta,ar_vincolata,origine_address,destinazione_address)
      VALUES ($1,$2,$3,1,'in_lavorazione','STANDARD',1,$4,$5,$6,$7,true,'5Q TEST ORIGINE','5Q TEST DESTINAZIONE')`,
      [r.id,cliente,r.start.toISOString(),`wallet_5q_${randomUUID()}`,r.requestId,gid,r.tratta]);
   await q("INSERT INTO transazioni_wallet(id,utente_id,importo,tipo,riferimento_id) VALUES ($1,$2,-1,'prenotazione',$3)",[index===0?walletA:walletR,cliente,r.requestId]);
  }
  const activations=[{id:attA,req:reqA,off:offA,vehicle:357,start:startA,end:endA},{id:attR,req:reqR,off:offR,vehicle:358,start:startR,end:endR}];
  for(const [index,a] of activations.entries()){
   // Piano placeholder: sufficiente al coordinatore, NON al finalizzatore.
   const piano={fixture5q:true,missioni:[],evaluation:{requests:[]}};
   await q(`INSERT INTO popbus_attivazioni(id,veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,expires_at)
      VALUES ($1,$2,2,'in_attesa_autista',$3,$4,1,1,1,$5::jsonb,$6)`,
      [a.id,a.vehicle,a.start.toISOString(),a.end.toISOString(),JSON.stringify(piano),expiry]);
   await q('INSERT INTO popbus_attivazione_richieste(attivazione_id,richiesta_id,attiva,indice_salita,indice_discesa) VALUES ($1,$2,true,0,1)',[a.id,a.req]);
   await q("INSERT INTO offerte_autisti(id,autista_id,stato,expires_at,attivazione_id) VALUES ($1,2,'inviata',$2,$3)",[a.off,expiry,a.id]);
   await q("INSERT INTO popbus_ar_accettazioni(id,attivazione_id,offerta_id,veicolo_id,stato,expires_at) VALUES ($1,$2,$3,$4,'provvisoria',$5)",[index===0?acceptA:acceptR,a.id,a.off,a.vehicle,expiry]);
  }
  const mod=await import(pathToFileURL(resolve('services/popbus/v2/popbus-ar-coordinator.service.js')).href);
  const result=await mod.analizzaDipendenzeAR(db,attA);
  if(result.stato!=='pronta'||result.attivazioni.length!==2||result.gruppi.length!==1||result.anomalie.length) fail('coordinatore non pronto: '+JSON.stringify(result));
  if(!result.attivazioni.every(x=>[attA,attR].includes(Number(x)))) fail('dipendenze esterne alla fixture');
  console.log('PASS: coordinatore reale A/R = pronta');
  const preflightMod=await import(pathToFileURL(resolve('services/popbus/v2/popbus-ar-transaction-preflight.service.js')).href);
  const pf=await preflightMod.preflightTransazionaleAR(db,attA);
  if(pf.stato!=='pronta'||pf.fase!=='preflight_transazionale'||pf.confermaAbilitata!==false||pf.attivazioniBloccate.length!==2||pf.gruppiBloccati.length!==1||pf.anomalie.length) fail('preflight transazionale non coerente: '+JSON.stringify(pf));
  if(!pf.attivazioniBloccate.every(x=>[attA,attR].includes(Number(x)))) fail('preflight include attivazioni estranee');
  console.log('PASS: preflight transazionale A/R reale = pronta, lock verificati');
  console.log('PASS: 2 attivazioni, 2 richieste, 2 veicoli test, 1 gruppo sintetico');
  console.log('PASS: pagamento wallet sintetico, nessuna chiamata Stripe');
  console.log('NOTA: piano placeholder; conversione PIXEL e finalizzaAttivazioniAR NON eseguiti');
 } finally {
  if(tx){try{await q('ROLLBACK');console.log('ROLLBACK OK');}catch(e){console.error('ROLLBACK NON CONFERMATO:',e.message);process.exitCode=2;}}
  await db.end().catch(()=>{});
 }
}
main().catch(e=>{console.error('STOP:',e.code||'',e.message);process.exitCode=1;});
