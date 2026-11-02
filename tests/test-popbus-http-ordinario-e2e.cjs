'use strict';
// TURENTU: regressione HTTP POPBUS ordinario con fixture sintetica e cleanup.
// Eseguire SOLO dopo aver verificato le precondizioni. --cleanup recupera il journal.
const {Client}=require('pg');
const {randomUUID,randomInt}=require('node:crypto');
const {resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');

const cleanupOnly=process.argv.includes('--cleanup');
const stop=m=>{throw Error('ORDINARIO STOP: '+m)};
if(process.env.TURENTU_TEST_AR_CONFIRM!=='COMMIT_FIXTURE_AND_CLEANUP')stop('Conferma esplicita assente');
if(!process.env.DATABASE_URL)stop('DATABASE_URL assente');
if(!cleanupOnly&&(!process.env.JWT_SECRET||process.env.JWT_SECRET==='segreto-di-test'))stop('JWT_SECRET esplicito richiesto');
if(process.env.STRIPE_SECRET_KEY&&!/^sk_test_/.test(process.env.STRIPE_SECRET_KEY))stop('Stripe LIVE vietato');
if(process.env.POPBUS_CONDUCENTI_ENABLED==='true')stop('Conducenti deve essere OFF');
if(process.env.POPBUS_AR_FINALIZATION_ENABLED==='true'&&!cleanupOnly)stop('Flag A/R deve essere OFF');
const journal=path.resolve('tests','.popbus-ordinario-http-fixture.json');
const ssl=process.env.TURENTU_RENDER_SSL_DIAGNOSTIC==='1'?{rejectUnauthorized:false}:{rejectUnauthorized:true};
const client=()=>new Client({connectionString:process.env.DATABASE_URL,ssl,connectionTimeoutMillis:15000,application_name:'turentu_ordinario_http_fixture'});
let ids;
const writeJournal=()=>fs.writeFileSync(journal,JSON.stringify(ids,null,2),{flag:'wx',mode:0o600});
function loadJournal(){ids=JSON.parse(fs.readFileSync(journal,'utf8'));if(ids.marker!=='TURENTU_ORD_HTTP_FIXTURE_V1')stop('Journal non riconosciuto')}
async function dbCheck(c){
 const db=await c.query('SELECT current_database() AS db');
 if(db.rows[0]?.db!=='corse_db')stop('Database inatteso');
 const v=await c.query('SELECT id,driver_id,stato,posti_totali FROM veicolo WHERE id=$1',[357]);
 if(v.rowCount!==1||v.rows[0].stato!=='test'||Number(v.rows[0].driver_id)!==2||Number(v.rows[0].posti_totali)<1)stop('Veicolo test 357 non valido');
}
async function state(c){
 const {rows}=await c.query(`SELECT a.id,a.stato,a.corsa_id,o.id AS offerta_id,o.stato AS offerta_stato
 FROM popbus_attivazioni a LEFT JOIN offerte_autisti o ON o.attivazione_id=a.id WHERE a.id=$1`,[ids.activation]);
 return rows;
}
async function cleanup(){
 const c=client();await c.connect();let tx=false;
 try{
  await dbCheck(c);await c.query('BEGIN');tx=true;
  await c.query("SET LOCAL lock_timeout='4000ms'");
  await c.query("SET LOCAL statement_timeout='20000ms'");
  await c.query('SELECT pg_advisory_xact_lock(734021,1)');
  const rows=await state(c);
  if(rows.length>1||rows.some(r=>Number(r.id)!==ids.activation||Number(r.offerta_id)!==ids.offer))stop('Attivazione/offerta non riconosciuta');
  const req=await c.query('SELECT id,cliente_id,ar_group_id,ar_vincolata FROM richieste_pop_bus WHERE id=$1',[ids.request]);
  if(req.rows.some(r=>Number(r.cliente_id)!==ids.cliente||r.ar_group_id!==null||r.ar_vincolata===true))stop('Richiesta non riconosciuta');
  const user=await c.query('SELECT nome FROM utente WHERE id=$1',[ids.cliente]);
  if(user.rows.some(r=>r.nome!=='5Q FIXTURE ORDINARIO'))stop('Utente non sintetico');
  const corsaIds=rows.map(r=>r.corsa_id).filter(x=>x!==null).map(Number);
  if(corsaIds.length>1||corsaIds.some(x=>!Number.isSafeInteger(x)||x<=0))stop('Corsa inattesa');
  const refs=await c.query(`SELECT conrelid::regclass::text AS tbl,conname FROM pg_constraint
   WHERE contype='f' AND confrelid='public.corse'::regclass`);
  const known=new Set(['prenotazioni','pagamenti','popbus_attivazioni','richieste_pop_bus']);
  for(const f of refs.rows.filter(x=>!known.has(x.tbl.replace(/^public\./,'')))){
   const col=await c.query(`SELECT a.attname AS col FROM pg_constraint co
    JOIN unnest(co.conkey) AS k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid=co.conrelid AND a.attnum=k.attnum
    WHERE co.conname=$1 AND co.conrelid=$2::regclass`,[f.conname,f.tbl]);
   if(col.rows.length!==1)stop('FK complessa: '+f.tbl);
   const tbl=f.tbl.replace(/^public\./,''),field=col.rows[0].col;
   if(!/^[a-z_][a-z_0-9]*$/.test(tbl)||!/^[a-z_][a-z_0-9]*$/.test(field))stop('FK identifier non valido');
   const hit=await c.query(`SELECT 1 FROM public."${tbl}" WHERE "${field}"=ANY($1::bigint[]) LIMIT 1`,[corsaIds]);
   if(hit.rowCount)stop('Dipendenza esterna: '+tbl);
  }
  const bookings=await c.query('SELECT id FROM prenotazioni WHERE corsa_id=ANY($1::bigint[])',[corsaIds]);
  const payments=await c.query('SELECT id FROM pagamenti WHERE corsa_id=ANY($1::bigint[])',[corsaIds]);
  if(bookings.rowCount>1||payments.rowCount>1)stop('Dipendenze inattese');
  await c.query('DELETE FROM pagamenti WHERE corsa_id=ANY($1::bigint[])',[corsaIds]);
  await c.query('DELETE FROM prenotazioni WHERE corsa_id=ANY($1::bigint[])',[corsaIds]);
  await c.query("UPDATE richieste_pop_bus SET corsa_id=NULL,stato='in_lavorazione' WHERE id=$1",[ids.request]);
  await c.query("UPDATE popbus_attivazioni SET corsa_id=NULL,stato='in_attesa_autista' WHERE id=$1",[ids.activation]);
  await c.query('DELETE FROM corse WHERE id=ANY($1::bigint[])',[corsaIds]);
  await c.query('DELETE FROM offerte_autisti WHERE id=$1',[ids.offer]);
  await c.query('DELETE FROM popbus_attivazione_richieste WHERE attivazione_id=$1',[ids.activation]);
  await c.query('DELETE FROM popbus_attivazioni WHERE id=$1',[ids.activation]);
  await c.query('DELETE FROM transazioni_wallet WHERE id=$1',[ids.wallet]);
  await c.query('DELETE FROM richieste_pop_bus WHERE id=$1',[ids.request]);
  await c.query("DELETE FROM utente WHERE id=$1 AND nome='5Q FIXTURE ORDINARIO'",[ids.cliente]);
  await c.query('COMMIT');tx=false;
  assert.equal((await state(c)).length,0);
  fs.unlinkSync(journal);
  console.log('PASS: cleanup ordinario completato; journal rimosso');
 }catch(e){if(tx)await c.query('ROLLBACK').catch(()=>{});console.error('CLEANUP NON CONFERMATO; journal conservato:',journal);throw e}
 finally{await c.end().catch(()=>{})}
}
async function createFixture(){
 const c=client();await c.connect();let tx=false;
 try{
  await dbCheck(c);await c.query('BEGIN');tx=true;
  await c.query("SET LOCAL lock_timeout='4000ms'");
  await c.query("SET LOCAL statement_timeout='20000ms'");
  await c.query('SELECT pg_advisory_xact_lock(734021,1)');
  const start=new Date(ids.start),end=new Date(start.getTime()+3600000);
  await c.query("INSERT INTO utente(id,nome,email,tipo,password) VALUES($1,'5Q FIXTURE ORDINARIO',$2,'cliente',$3)",[ids.cliente,`fixture-ord-${randomUUID()}@invalid.example`,'!non-login-fixture!']);
  await c.query(`INSERT INTO richieste_pop_bus(id,cliente_id,start_datetime,posti_richiesti,stato,classe,prezzo,payment_intent_id,request_id,ar_vincolata,origine_address,destinazione_address)
  VALUES($1,$2,$3,1,'in_lavorazione','STANDARD',1,$4,$5,false,'5Q TEST ORIGINE','5Q TEST DESTINAZIONE')`,
  [ids.request,ids.cliente,start.toISOString(),`wallet_ord_${randomUUID()}`,ids.rid]);
  await c.query("INSERT INTO transazioni_wallet(id,utente_id,importo,tipo,riferimento_id) VALUES($1,$2,-1,'prenotazione',$3)",[ids.wallet,ids.cliente,ids.rid]);
  const fp=await import(pathToFileURL(resolve('services/popbus/v2/request-fingerprint.js')).href);
  const avmod=await import(pathToFileURL(resolve('services/popbus/v2/popbus-vehicle-availability.js')).href);
  const acceptance=await import(pathToFileURL(resolve('services/popbus/v2/acceptance.js')).href);
  const polylineMod=await import('polyline');const polyline=polylineMod.default??polylineMod;
  const rr=(await c.query('SELECT * FROM richieste_pop_bus WHERE id=$1',[ids.request])).rows[0];
  const from={id:8,lat:40.146,lon:18.310,nome_nodo:'5Q Origine'};
  const to={id:7,lat:40.354,lon:18.170,nome_nodo:'5Q Destinazione'};
  const piano={fixture5q:true,missioni:[],busyStart:start.toISOString(),busyEnd:end.toISOString(),
    evaluation:{requests:[{id:ids.request,start:0,end:1}],departure:start.getTime(),times:[0,3600000],peak:1},
    requestSnapshot:[{id:ids.request,fingerprint:fp.fingerprintRichiesta(rr)}],
    coordinates:[from,to],legs:[{polyline:polyline.encode([[from.lat,from.lon],[to.lat,to.lon]])}],
    approach:{metres:0},returnTrip:{metres:0}};
  const av=await c.query('SELECT start,fine,giorni_esclusi,inattivita FROM disponibilita_veicolo WHERE veicolo_id=357');
  if(!av.rows.some(v=>avmod.verificaTurnoVeicolo(v,start.getTime(),end.getTime())))stop('Disponibilita veicolo 357 insufficiente');
  if(await acceptance.verificaPagamento(c,rr)!=='pagato')stop('Pagamento fixture non verificato');
  await c.query(`INSERT INTO popbus_attivazioni(id,veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,expires_at)
    VALUES($1,357,2,'in_attesa_autista',$2,$3,1,1,1,$4::jsonb,$5)`,[ids.activation,start.toISOString(),end.toISOString(),JSON.stringify(piano),ids.expiry]);
  await c.query('INSERT INTO popbus_attivazione_richieste(attivazione_id,richiesta_id,attiva,indice_salita,indice_discesa) VALUES($1,$2,true,0,1)',[ids.activation,ids.request]);
  await c.query("INSERT INTO offerte_autisti(id,autista_id,stato,expires_at,attivazione_id) VALUES($1,2,'inviata',$2,$3)",[ids.offer,ids.expiry,ids.activation]);
  await c.query('COMMIT');tx=false;
  console.log('PASS: fixture ordinaria creata; journal:',journal);
 }catch(e){if(tx)await c.query('ROLLBACK').catch(()=>{});throw e}
 finally{await c.end().catch(()=>{})}
}
async function verify(){
 const c=client();await c.connect();
 try{
  const rows=await state(c);
  assert.equal(rows.length,1);
  assert.equal(rows[0].stato,'confermata');
  assert.equal(rows[0].offerta_stato,'accettata');
  const corsaId=Number(rows[0].corsa_id);assert(Number.isSafeInteger(corsaId)&&corsaId>0);
  const q=await c.query(`SELECT
   (SELECT count(*)::int FROM prenotazioni WHERE corsa_id=$1) AS prenotazioni,
   (SELECT count(*)::int FROM pagamenti WHERE corsa_id=$1) AS pagamenti,
   (SELECT count(*)::int FROM richieste_pop_bus WHERE id=$2 AND corsa_id=$1 AND stato='convertita') AS richieste`,[corsaId,ids.request]);
  assert.deepEqual(q.rows[0],{prenotazioni:1,pagamenti:1,richieste:1});
  return corsaId;
 }finally{await c.end().catch(()=>{})}
}
async function main(){
 if(cleanupOnly){if(!fs.existsSync(journal))stop('Journal assente');loadJournal();await cleanup();return}
 if(fs.existsSync(journal))stop('Journal ordinario preesistente: prima --cleanup');
 const v=Array.from({length:5},()=>randomInt(1500000000,2000000000));
 if(new Set(v).size!==v.length)stop('Collisione ID');
 const start=new Date(Date.now()+48*3600000);start.setUTCHours(9,0,0,0);
 ids={marker:'TURENTU_ORD_HTTP_FIXTURE_V1',cliente:v[0],request:v[1],activation:v[2],offer:v[3],wallet:v[4],
  rid:randomUUID(),start:start.toISOString(),expiry:new Date(Date.now()+3600000).toISOString()};
 writeJournal();let server;
 try{
  await createFixture();
  const express=(await import('express')).default;
  const jwt=require('jsonwebtoken');
  const router=(await import(pathToFileURL(resolve('routes/popbus.routes.js')).href)).popbusRouter;
  const app=express();app.use(express.json());app.use('/api/popbus',router);
  server=await new Promise((ok,fail)=>{const s=app.listen(0,'127.0.0.1',()=>ok(s));s.on('error',fail)});
  const base='http://127.0.0.1:'+server.address().port;
  const request=async(operator)=>{
   const token=jwt.sign({id:operator,role:'autista'},process.env.JWT_SECRET,{expiresIn:'5m'});
   const response=await fetch(base+'/api/popbus/'+ids.offer+'/accetta',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:'{}'});
   return {status:response.status,body:await response.json()};
  };
  // La flag A/R deve rimanere OFF: il ramo ordinario deve continuare a funzionare.
  const unauthorized=await request(3);
  assert([403,404,409].includes(unauthorized.status),'Operatore estraneo non rifiutato: '+JSON.stringify(unauthorized));
  // Verifica indipendente di assenza scritture.
  const chk=client();await chk.connect();
  try{const rows=await state(chk);assert.equal(rows.length,1);assert.equal(rows[0].corsa_id,null);assert.equal(rows[0].stato,'in_attesa_autista')}finally{await chk.end()}
  console.log('PASS: NCC estraneo respinto e nessuna corsa creata');
  const first=await request(2);
  assert.equal(first.status,200,JSON.stringify(first));
  assert.equal(first.body.ok,true);
  assert(Number.isSafeInteger(Number(first.body.corsa_id))&&Number(first.body.corsa_id)>0);
  console.log('PASS: HTTP ordinario -> 200 con flag A/R OFF');
  const corsaId=await verify();assert.equal(Number(first.body.corsa_id),corsaId);
  console.log('PASS: COMMIT ordinario, 1 corsa, 1 prenotazione, 1 pagamento');
  const retry=await request(2);
  assert.equal(retry.status,200,JSON.stringify(retry));
  assert.equal(Number(retry.body.corsa_id),corsaId);
  assert.equal(await verify(),corsaId);
  console.log('PASS: retry ordinario idempotente');
 }finally{
  if(server)await new Promise(ok=>server.close(ok));
  try{await cleanup()}catch(e){console.error('Cleanup manuale: node tests\\test-popbus-http-ordinario-e2e.cjs --cleanup');throw e}
 }
 console.log('PASS: REGRESSIONE HTTP ORDINARIA COMPLETATA');
}
main().catch(e=>{console.error('STOP:',e.code||'',e.message);process.exitCode=1});
