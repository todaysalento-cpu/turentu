'use strict';
// Fase 5R.2 corretta - esclusione lock tra connessioni + finalizzatore reale; ROLLBACK_ONLY.
// Due scenari indipendenti: conversione completa e errore sulla seconda corsa.
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
let db = new Client({ connectionString:process.env.DATABASE_URL, ssl, connectionTimeoutMillis:15000, application_name:'turentu_5q_fixture_rollback' });
let tx=false;
let scenario = '';
let finalizerRan = false;
let interceptedCommit = false;
let createdCorse = 0;
let injectedFailure = false;
const fixtureIds = [];

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
async function runScenario(mode){
 scenario=mode; tx=false; finalizerRan=false; interceptedCommit=false; createdCorse=0; injectedFailure=false;
 db=new Client({connectionString:process.env.DATABASE_URL,ssl,connectionTimeoutMillis:15000,application_name:'turentu_5r2_rollback_'+mode});
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
  const fingerprintMod=await import(pathToFileURL(resolve('services/popbus/v2/request-fingerprint.js')).href);
  const availabilityMod=await import(pathToFileURL(resolve('services/popbus/v2/popbus-vehicle-availability.js')).href);
  const acceptanceMod=await import(pathToFileURL(resolve('services/popbus/v2/acceptance.js')).href);
  const polylineMod=await import('polyline');
  const polyline=polylineMod.default ?? polylineMod;
  const activations=[{id:attA,req:reqA,off:offA,vehicle:357,start:startA,end:endA},{id:attR,req:reqR,off:offR,vehicle:358,start:startR,end:endR}];
  for(const [index,a] of activations.entries()){
   const {rows: currentReq}=await q('SELECT * FROM richieste_pop_bus WHERE id=$1',[a.req]);
   if(currentReq.length!==1) fail('richiesta sintetica non trovata');
   const snapshot={id:a.req,fingerprint:fingerprintMod.fingerprintRichiesta(currentReq[0])};
   const from=index===0?{id:8,lat:40.146,lon:18.310,nome_nodo:'5Q Origine'}:{id:7,lat:40.354,lon:18.170,nome_nodo:'5Q Ritorno origine'};
   const to=index===0?{id:7,lat:40.354,lon:18.170,nome_nodo:'5Q Destinazione'}:{id:8,lat:40.146,lon:18.310,nome_nodo:'5Q Ritorno destinazione'};
   const geometry=polyline.encode([[from.lat,from.lon],[to.lat,to.lon]]);
   const piano={fixture5q:true,missioni:[],busyStart:a.start.toISOString(),busyEnd:a.end.toISOString(),
     evaluation:{requests:[{id:a.req,start:0,end:1}],departure:a.start.getTime(),times:[0,3600000],peak:1},
     requestSnapshot:[snapshot],coordinates:[from,to],legs:[{polyline:geometry}],
     approach:{metres:0},returnTrip:{metres:0}};
   if(polyline.decode(geometry).length<2) fail('polilinea sintetica non valida');
   const {rows: availability}=await q('SELECT start,fine,giorni_esclusi,inattivita FROM disponibilita_veicolo WHERE veicolo_id=$1',[a.vehicle]);
   if(!availability.some(v=>availabilityMod.verificaTurnoVeicolo(v,a.start.getTime(),a.end.getTime())))
     fail('turno veicolo '+a.vehicle+' non copre il piano 5Q.2: scegliere una finestra compatibile');
   const walletState=await acceptanceMod.verificaPagamento(db,currentReq[0]);
   if(walletState!=='pagato') fail('wallet sintetico non verificato');
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
  console.log('PASS: wallet verificato dalla funzione reale, nessuna chiamata Stripe');
  console.log('PASS: piani POPBUS 5Q.2, fingerprint, geometria e disponibilita verificati');
  // Guard: finalizzatore deve operare sulla STESSA connessione e non puo' confermare.
  // La transazione della fixture e' gia' aperta: BEGIN del finalizzatore diventa no-op.
  // COMMIT del finalizzatore viene intercettato: prima verifica, poi ROLLBACK reale.
  const protectedClient={
   query:async (sql, params)=>{
    const s=typeof sql==='string'?sql:sql?.text;
    const norm=String(s||'').trim().replace(/;$/, '').toUpperCase();
    if(norm==='BEGIN') return {rows:[],rowCount:null};
    if(norm==='COMMIT'){
     if(mode!=='success') fail('COMMIT inatteso nello scenario di errore');
     const counts=await q(`SELECT
      (SELECT count(*)::int FROM corse WHERE veicolo_id IN (357,358) AND id IN
        (SELECT corsa_id FROM popbus_attivazioni WHERE id=ANY($1::bigint[]))) AS corse,
      (SELECT count(*)::int FROM prenotazioni WHERE corsa_id IN
        (SELECT corsa_id FROM popbus_attivazioni WHERE id=ANY($1::bigint[]))) AS prenotazioni,
      (SELECT count(*)::int FROM pagamenti WHERE corsa_id IN
        (SELECT corsa_id FROM popbus_attivazioni WHERE id=ANY($1::bigint[]))) AS pagamenti,
      (SELECT count(*)::int FROM richieste_pop_bus WHERE id=ANY($2::bigint[]) AND stato='convertita' AND corsa_id IS NOT NULL) AS richieste,
      (SELECT count(*)::int FROM popbus_attivazioni WHERE id=ANY($1::bigint[]) AND stato='confermata' AND corsa_id IS NOT NULL) AS attivazioni,
      (SELECT count(*)::int FROM offerte_autisti WHERE id=ANY($3::bigint[]) AND stato='accettata') AS offerte,
      (SELECT count(*)::int FROM popbus_ar_accettazioni WHERE attivazione_id=ANY($1::bigint[]) AND stato='confermata') AS accettazioni,
      (SELECT count(*)::int FROM ar_gruppi WHERE id=$4 AND stato='confermato') AS gruppi`,
      [[attA,attR],[reqA,reqR],[offA,offR],gid]);
     const c=counts.rows[0];
     for(const [k,n] of Object.entries({corse:2,prenotazioni:2,pagamenti:2,richieste:2,attivazioni:2,offerte:2,accettazioni:2,gruppi:1}))
       if(Number(c[k])!==n) fail('stato prima del rollback non valido: '+JSON.stringify(c));
     console.log('PASS: finalizzatore reale, 2 corse + 2 prenotazioni + 2 pagamenti verificati nella transazione');
     await q('ROLLBACK');tx=false;interceptedCommit=true;
     console.log('PASS: COMMIT intercettato e sostituito da ROLLBACK');
     return {rows:[],rowCount:null};
    }
    if(norm==='ROLLBACK'){
      if(tx){await q('ROLLBACK');tx=false;}
      return {rows:[],rowCount:null};
    }
    if(/^(?:COMMIT\s|END(?:\s|$)|PREPARE\s+TRANSACTION|SET\s+SESSION|CREATE\s|ALTER\s|DROP\s|TRUNCATE\s|COPY\s)/i.test(norm)) fail('SQL non autorizzato nel client protetto: '+norm.slice(0,80));
    if(/^INSERT\s+INTO\s+CORSE\b/i.test(norm)){
      createdCorse++;
      if(mode==='fail_second' && createdCorse===2){injectedFailure=true;throw new Error('5R2_INJECTED_SECOND_LEG_FAILURE');}
    }
    return db.query(sql,params);
   },
   release:()=>{} // la connessione e' posseduta dallo script, mai dal finalizzatore
  };
  const protectedPool={connect:async()=>protectedClient};
  finalizerRan=true;
  if(mode==='success'){
    // Il preflight della fixture detiene gia' il lock advisory (734021,1).
    // Una seconda connessione DEVE risultare esclusa senza attendere.
    const contender=new Client({connectionString:process.env.DATABASE_URL,ssl,connectionTimeoutMillis:15000,application_name:'turentu_5r2_lock_contender'});
    let contenderTx=false;
    try {
      await contender.connect();
      await contender.query('BEGIN'); contenderTx=true;
      await contender.query("SET LOCAL statement_timeout = '3000ms'");
      const lock=await contender.query('SELECT pg_try_advisory_xact_lock(734021,1) AS acquired');
      if(lock.rows[0]?.acquired!==false) fail('seconda connessione ha acquisito il lock mentre il preflight lo detiene');
      console.log('PASS: seconda connessione esclusa dal lock del preflight A/R');
    } finally {
      if(contenderTx) await contender.query('ROLLBACK').catch(()=>{});
      await contender.end().catch(()=>{});
    }
    // Finalizzazione reale sulla connessione protetta, senza COMMIT effettivo.
    const result=await acceptanceMod.finalizzaAttivazioniAR(protectedPool,attA,new Map());
    if(result.stato!=='confermato'||result.corse?.length!==2||!interceptedCommit||tx) fail('risultato finalizzatore incompleto');
    console.log('PASS: scenario successo, rollback verificato');
  }else{
    let caught=null;
    try{await acceptanceMod.finalizzaAttivazioniAR(protectedPool,attA,new Map());}
    catch(e){caught=e;}
    if(!caught||!injectedFailure||!String(caught.message).includes('5R2_INJECTED_SECOND_LEG_FAILURE')||tx||interceptedCommit)
      fail('scenario errore non correttamente annullato: '+(caught?.message||'nessun errore'));
    console.log('PASS: errore iniettato sulla seconda corsa, ROLLBACK interno eseguito');
  }
  // Verifica su connessione nuova: nessuna fixture sopravvissuta al rollback.
  const check=new Client({connectionString:process.env.DATABASE_URL,ssl,connectionTimeoutMillis:15000,application_name:'turentu_5r2_postrollback'});
  try{
   await check.connect();
   const tables=[['utente','id',[cliente]],['ar_gruppi','id',[gid]],['richieste_pop_bus','id',[reqA,reqR]],
    ['popbus_attivazioni','id',[attA,attR]],['offerte_autisti','id',[offA,offR]],
    ['popbus_ar_accettazioni','id',[acceptA,acceptR]],['transazioni_wallet','id',[walletA,walletR]]];
   for(const [table,col,values] of tables){
     const res=await check.query('SELECT count(*)::int AS n FROM '+table+' WHERE '+col+'::text=ANY($1::text[])',[values.map(String)]);
     if(res.rows[0].n!==0) fail('fixture persistita in '+table);
   }
   // Le corse/prenotazioni/pagamenti non hanno ID predefiniti: verifica tramite le richieste sintetiche
   // e i pagamenti wallet; la transazione intercettata non e' mai stata confermata.
   console.log('PASS: fixture assente su nuova connessione dopo ROLLBACK');
  }finally{await check.end().catch(()=>{});}

 } finally {
  if(tx){try{await q('ROLLBACK');tx=false;console.log('ROLLBACK OK (cleanup)');}catch(e){console.error('ROLLBACK NON CONFERMATO:',e.message);process.exitCode=2;}}
  await db.end().catch(()=>{});
 }
}
(async()=>{
 await runScenario('success');
 await runScenario('fail_second');
 console.log('PASS: FASE 5R.2 ROLLBACK_ONLY: esclusione lock e atomicita verificate, nessun COMMIT reale');
 console.log('LIMITE: non e una prova di due finalizzazioni concorrenti ne di idempotenza dopo COMMIT');
})().catch(e=>{console.error('STOP:',e.code||'',e.message);process.exitCode=1;});
