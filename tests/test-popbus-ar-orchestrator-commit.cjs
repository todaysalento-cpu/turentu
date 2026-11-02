'use strict';
// TURENTU A/R COMMIT test. ONLY synthetic rows. Explicit opt-in required.
// Usage: set TURENTU_TEST_AR_CONFIRM=COMMIT_FIXTURE_AND_CLEANUP
//        node tests\test-popbus-ar-orchestrator-commit.cjs
// Recovery: node tests\test-popbus-ar-orchestrator-commit.cjs --cleanup
const { Client } = require('pg');
const { randomUUID, randomInt } = require('node:crypto');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const stop = msg => { throw new Error('AR COMMIT STOP: ' + msg); };
const cleanupOnly = process.argv.includes('--cleanup');
if (process.env.TURENTU_TEST_AR_CONFIRM !== 'COMMIT_FIXTURE_AND_CLEANUP') stop('Conferma esplicita assente');
if (!process.env.DATABASE_URL) stop('DATABASE_URL assente');
if (process.env.STRIPE_SECRET_KEY && !/^sk_test_/.test(process.env.STRIPE_SECRET_KEY)) stop('Stripe LIVE non consentito');
if (process.env.POPBUS_CONDUCENTI_ENABLED === 'true') stop('Per questo test POPBUS_CONDUCENTI_ENABLED deve essere OFF');
if (process.env.POPBUS_AR_FINALIZATION_ENABLED === 'true' && !cleanupOnly) stop('Lascia il flag A/R OFF; lo script lo abilita localmente dopo il COMMIT delle fixture');
const ssl = process.env.TURENTU_RENDER_SSL_DIAGNOSTIC === '1' ? {rejectUnauthorized:false} : {rejectUnauthorized:true};
const journal = path.resolve('tests', '.popbus-ar-commit-fixture.json');
const newClient = () => new Client({connectionString:process.env.DATABASE_URL,ssl,connectionTimeoutMillis:15000,application_name:'turentu_ar_commit_fixture'});
let ids;
function writeJournal() { fs.writeFileSync(journal, JSON.stringify(ids,null,2), {flag:'wx',mode:0o600}); }
function loadJournal() { ids=JSON.parse(fs.readFileSync(journal,'utf8')); if(ids.marker!=='TURENTU_AR_COMMIT_FIXTURE_V1') stop('Journal non valido'); }
async function dbCheck(c) {
 const r=await c.query('SELECT current_database() AS db');
 if(r.rows[0]?.db!=='corse_db') stop('Database inatteso');
 const v=await c.query('SELECT id,driver_id,stato,posti_totali FROM veicolo WHERE id=ANY($1::int[]) ORDER BY id',[[357,358]]);
 if(v.rowCount!==2 || v.rows.some(x=>x.stato!=='test'||Number(x.driver_id)!==2||Number(x.posti_totali)<1)) stop('Veicoli di test 357/358 non validi');
}
async function inspect(c) {
 const r=await c.query(`SELECT a.id,a.stato,a.corsa_id,o.id AS offerta_id,o.stato AS offerta_stato,
   p.id AS accettazione_id,p.stato AS accettazione_stato
   FROM popbus_attivazioni a LEFT JOIN offerte_autisti o ON o.attivazione_id=a.id
   LEFT JOIN popbus_ar_accettazioni p ON p.attivazione_id=a.id
   WHERE a.id=ANY($1::bigint[]) ORDER BY a.id`,[ids.activations]);
 const corsaIds=r.rows.map(x=>Number(x.corsa_id)).filter(Number.isSafeInteger);
 return {rows:r.rows,corsaIds};
}
async function cleanup() {
 const c=newClient(); await c.connect(); let begun=false;
 try {
  await dbCheck(c);
  await c.query('BEGIN'); begun=true;
  await c.query("SET LOCAL lock_timeout='4000ms'");
  await c.query("SET LOCAL statement_timeout='20000ms'");
  await c.query('SELECT pg_advisory_xact_lock(734021,1)');
  const state=await inspect(c);
  if(state.rows.length && (state.rows.length!==2 || state.rows.some(x=>!ids.activations.includes(Number(x.id)) || !ids.offers.includes(Number(x.offerta_id))))) stop('Fixture alterata o riferimenti estranei: cleanup sospeso');
  if(new Set(state.corsaIds).size!==state.corsaIds.length || state.corsaIds.length>2) stop('Corse fixture incoerenti');
  const r=await c.query('SELECT id,cliente_id,ar_group_id FROM richieste_pop_bus WHERE id=ANY($1::bigint[])',[ids.requests]);
  if(r.rows.some(x=>Number(x.cliente_id)!==ids.cliente || x.ar_group_id!==ids.gid)) stop('Richieste non riconosciute: cleanup sospeso');
  const owned=await c.query('SELECT id,nome FROM utente WHERE id=$1',[ids.cliente]);
  if(owned.rows.length && (owned.rows.length!==1 || owned.rows[0].nome!=='5Q FIXTURE COMMIT')) stop('Utente non sintetico');
  // Do not delete when unknown dependent rows reference the fixture corse/prenotazioni.
  const knownCourseRefs=new Set(['prenotazioni','pagamenti','popbus_attivazioni','richieste_pop_bus']);
  const foreign=await c.query(`SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint
    WHERE contype='f' AND confrelid='public.corse'::regclass`);
  const unexpected=foreign.rows.filter(x=>!knownCourseRefs.has(x.tbl.replace(/^public\./,'')));
  // These tables may exist but must not reference our courses; test each FK column dynamically.
  for(const f of unexpected){
    const col=await c.query(`SELECT a.attname AS col FROM pg_constraint co
      JOIN unnest(co.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid=co.conrelid AND a.attnum=k.attnum
      WHERE co.conname=$1 AND co.conrelid=$2::regclass`,[f.conname,f.tbl]);
    if(col.rows.length!==1) stop('FK complessa non verificabile: '+f.tbl);
    const tbl=f.tbl.replace(/^public\./,'');
    if(!/^[a-z_][a-z_0-9]*$/.test(tbl) || !/^[a-z_][a-z_0-9]*$/.test(col.rows[0].col)) stop('Identificatore FK inatteso');
    const hit=await c.query(`SELECT 1 FROM public."${tbl}" WHERE "${col.rows[0].col}"=ANY($1::bigint[]) LIMIT 1`,[state.corsaIds]);
    if(hit.rowCount) stop('Dipendenza estranea su corse: '+tbl);
  }
  // For bookings, guard against external dependent rows: deletion must fail closed.
  const bookings=await c.query('SELECT id FROM prenotazioni WHERE corsa_id=ANY($1::bigint[])',[state.corsaIds]);
  if(bookings.rows.length>2) stop('Prenotazioni aggiuntive sulla fixture');
  const bookingIds=bookings.rows.map(x=>Number(x.id));
  const payment=await c.query('SELECT id FROM pagamenti WHERE corsa_id=ANY($1::bigint[])',[state.corsaIds]);
  if(payment.rows.length>2) stop('Pagamenti aggiuntivi sulla fixture');
  await c.query('DELETE FROM pagamenti WHERE corsa_id=ANY($1::bigint[])',[state.corsaIds]);
  await c.query('DELETE FROM prenotazioni WHERE id=ANY($1::bigint[])',[bookingIds]);
  await c.query('UPDATE richieste_pop_bus SET corsa_id=NULL,stato=\'in_lavorazione\' WHERE id=ANY($1::bigint[])',[ids.requests]);
  await c.query('UPDATE popbus_attivazioni SET corsa_id=NULL,stato=\'in_attesa_autista\' WHERE id=ANY($1::bigint[])',[ids.activations]);
  await c.query('DELETE FROM corse WHERE id=ANY($1::bigint[])',[state.corsaIds]);
  await c.query('DELETE FROM popbus_ar_accettazioni WHERE attivazione_id=ANY($1::bigint[])',[ids.activations]);
  await c.query('DELETE FROM offerte_autisti WHERE id=ANY($1::bigint[])',[ids.offers]);
  await c.query('DELETE FROM popbus_attivazione_richieste WHERE attivazione_id=ANY($1::bigint[])',[ids.activations]);
  await c.query('DELETE FROM popbus_attivazioni WHERE id=ANY($1::bigint[])',[ids.activations]);
  await c.query('DELETE FROM transazioni_wallet WHERE id=ANY($1::bigint[])',[ids.wallets]);
  await c.query('DELETE FROM richieste_pop_bus WHERE id=ANY($1::bigint[])',[ids.requests]);
  await c.query('DELETE FROM ar_gruppi WHERE id=$1',[ids.gid]);
  await c.query('DELETE FROM utente WHERE id=$1 AND nome=\'5Q FIXTURE COMMIT\'',[ids.cliente]);
  await c.query('COMMIT'); begun=false;
  const check=await inspect(c);
  if(check.rows.length) stop('Attivazioni residue dopo cleanup');
  fs.unlinkSync(journal);
  console.log('PASS: cleanup COMMIT completato; journal rimosso');
 } catch(e) { if(begun) await c.query('ROLLBACK').catch(()=>{}); console.error('CLEANUP NON CONFERMATO. Journal conservato:',journal); throw e; }
 finally { await c.end().catch(()=>{}); }
}
async function createFixture() {
 const c=newClient(); await c.connect(); let tx=false;
 try {
  await dbCheck(c);
  await c.query('BEGIN');tx=true;
  await c.query("SET LOCAL statement_timeout='20000ms'");
  await c.query("SET LOCAL lock_timeout='4000ms'");
  await c.query('SELECT pg_advisory_xact_lock(734021,1)');
  const {cliente,requests:[reqA,reqR],activations:[attA,attR],offers:[offA,offR],wallets:[walletA,walletR],gid,rida,ridr,expiry,startA,startR}=ids;
  const startDates=[new Date(startA),new Date(startR)];
  await c.query("INSERT INTO utente(id,nome,email,tipo,password) VALUES ($1,'5Q FIXTURE COMMIT',$2,'cliente',$3)",[cliente,`fixture-5q-${randomUUID()}@invalid.example`,'!non-login-fixture!']);
  await c.query("INSERT INTO ar_gruppi(id,cliente_id,stato,expires_at) VALUES ($1,$2,'pronto',$3)",[gid,cliente,expiry]);
  for(const [i,r] of [{id:reqA,rid:rida,tratta:'andata'},{id:reqR,rid:ridr,tratta:'ritorno'}].entries()) {
   await c.query(`INSERT INTO richieste_pop_bus(id,cliente_id,start_datetime,posti_richiesti,stato,classe,prezzo,payment_intent_id,request_id,ar_group_id,ar_tratta,ar_vincolata,origine_address,destinazione_address)
     VALUES($1,$2,$3,1,'in_lavorazione','STANDARD',1,$4,$5,$6,$7,true,'5Q TEST ORIGINE','5Q TEST DESTINAZIONE')`,[r.id,cliente,startDates[i].toISOString(),`wallet_5q_${randomUUID()}`,r.rid,gid,r.tratta]);
   await c.query("INSERT INTO transazioni_wallet(id,utente_id,importo,tipo,riferimento_id) VALUES ($1,$2,-1,'prenotazione',$3)",[i===0?walletA:walletR,cliente,r.rid]);
  }
  const fingerprintMod=await import(pathToFileURL(resolve('services/popbus/v2/request-fingerprint.js')).href);
  const availabilityMod=await import(pathToFileURL(resolve('services/popbus/v2/popbus-vehicle-availability.js')).href);
  const acceptanceMod=await import(pathToFileURL(resolve('services/popbus/v2/acceptance.js')).href);
  const polylineMod=await import('polyline');const polyline=polylineMod.default??polylineMod;
  for(const [i,a] of [{id:attA,req:reqA,off:offA,vehicle:357},{id:attR,req:reqR,off:offR,vehicle:358}].entries()) {
   const start=startDates[i],end=new Date(start.getTime()+3600000);
   const {rows:rr}=await c.query('SELECT * FROM richieste_pop_bus WHERE id=$1',[a.req]);
   const from=i===0?{id:8,lat:40.146,lon:18.310,nome_nodo:'5Q Origine'}:{id:7,lat:40.354,lon:18.170,nome_nodo:'5Q Ritorno origine'};
   const to=i===0?{id:7,lat:40.354,lon:18.170,nome_nodo:'5Q Destinazione'}:{id:8,lat:40.146,lon:18.310,nome_nodo:'5Q Ritorno destinazione'};
   const geometry=polyline.encode([[from.lat,from.lon],[to.lat,to.lon]]);
   const piano={fixture5q:true,missioni:[],busyStart:start.toISOString(),busyEnd:end.toISOString(),evaluation:{requests:[{id:a.req,start:0,end:1}],departure:start.getTime(),times:[0,3600000],peak:1},requestSnapshot:[{id:a.req,fingerprint:fingerprintMod.fingerprintRichiesta(rr[0])}],coordinates:[from,to],legs:[{polyline:geometry}],approach:{metres:0},returnTrip:{metres:0}};
   const {rows:av}=await c.query('SELECT start,fine,giorni_esclusi,inattivita FROM disponibilita_veicolo WHERE veicolo_id=$1',[a.vehicle]);
   if(!av.some(v=>availabilityMod.verificaTurnoVeicolo(v,start.getTime(),end.getTime()))) stop('Disponibilita insufficiente per veicolo '+a.vehicle);
   if(await acceptanceMod.verificaPagamento(c,rr[0])!=='pagato') stop('Wallet fixture non verificato');
   await c.query(`INSERT INTO popbus_attivazioni(id,veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,expires_at)
     VALUES($1,$2,2,'in_attesa_autista',$3,$4,1,1,1,$5::jsonb,$6)`,[a.id,a.vehicle,start.toISOString(),end.toISOString(),JSON.stringify(piano),expiry]);
   await c.query('INSERT INTO popbus_attivazione_richieste(attivazione_id,richiesta_id,attiva,indice_salita,indice_discesa) VALUES($1,$2,true,0,1)',[a.id,a.req]);
   await c.query("INSERT INTO offerte_autisti(id,autista_id,stato,expires_at,attivazione_id) VALUES($1,2,'inviata',$2,$3)",[a.off,expiry,a.id]);
  }
  await c.query('COMMIT');tx=false;
  console.log('PASS: COMMIT fixture sintetica; journal:',journal);
 } catch(e) {if(tx) await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally {await c.end().catch(()=>{});}
}
async function verify() {
 const c=newClient();await c.connect();try {
  const state=await inspect(c);
  assert.equal(state.rows.length,2);
  assert.equal(state.corsaIds.length,2);
  assert.equal(new Set(state.corsaIds).size,2);
  assert(state.rows.every(r=>r.stato==='confermata' && r.offerta_stato==='accettata' && r.accettazione_stato==='confermata'));
  const counts=await c.query(`SELECT
    (SELECT count(*)::int FROM prenotazioni WHERE corsa_id=ANY($1::bigint[])) AS prenotazioni,
    (SELECT count(*)::int FROM pagamenti WHERE corsa_id=ANY($1::bigint[])) AS pagamenti,
    (SELECT count(*)::int FROM richieste_pop_bus WHERE id=ANY($2::bigint[]) AND stato='convertita' AND corsa_id=ANY($1::bigint[])) AS richieste,
    (SELECT count(*)::int FROM ar_gruppi WHERE id=$3 AND stato='confermato') AS gruppi`,[state.corsaIds,ids.requests,ids.gid]);
  for(const [k,n] of Object.entries({prenotazioni:2,pagamenti:2,richieste:2,gruppi:1})) assert.equal(counts.rows[0][k],n,k);
  return state.corsaIds;
 } finally {await c.end().catch(()=>{});}
}
async function main() {
 if(cleanupOnly) {if(!fs.existsSync(journal)) stop('Journal assente');loadJournal();await cleanup();return;}
 if(fs.existsSync(journal)) stop('Journal fixture preesistente: prima eseguire --cleanup');
 const vals=Array.from({length:9},()=>randomInt(1500000000,2000000000));
 if(new Set(vals).size!==vals.length) stop('Collisione ID');
 const start=new Date(Date.now()+48*3600000);start.setUTCHours(9,0,0,0);
 ids={marker:'TURENTU_AR_COMMIT_FIXTURE_V1',cliente:vals[0],requests:[vals[1],vals[2]],activations:[vals[3],vals[4]],offers:[vals[5],vals[6]],wallets:[vals[7],vals[8]],gid:randomUUID(),rida:randomUUID(),ridr:randomUUID(),expiry:new Date(Date.now()+3600000).toISOString(),startA:start.toISOString(),startR:new Date(start.getTime()+4*3600000).toISOString()};
 writeJournal();
 let completed=false;
 try {
  await createFixture();
  process.env.POPBUS_AR_FINALIZATION_ENABLED='true'; // ONLY local Node process.
  const mod=await import(pathToFileURL(resolve('services/popbus/v2/popbus-ar-orchestrator.service.js')).href);
  const first=await mod.accettaOffertaPopbusAR({attivazioneId:ids.activations[0],offertaId:ids.offers[0],operatoreId:2});
  assert.equal(first.stato,'in_attesa');console.log('PASS: prima accettazione = in_attesa');
  const second=await mod.accettaOffertaPopbusAR({attivazioneId:ids.activations[1],offertaId:ids.offers[1],operatoreId:2});
  assert.equal(second.stato,'confermato');assert.equal(second.corse?.length,2);console.log('PASS: seconda accettazione = confermato');
  const before=await verify();console.log('PASS: COMMIT verificato su connessione nuova');
  const duplicate=await mod.accettaOffertaPopbusAR({attivazioneId:ids.activations[0],offertaId:ids.offers[0],operatoreId:2});
  assert.equal(duplicate.stato,'confermato');assert.equal(duplicate.giaConfermato,true);
  assert.deepEqual(await verify(),before);console.log('PASS: duplicato senza nuove corse');
  completed=true;
 } finally {
  process.env.POPBUS_AR_FINALIZATION_ENABLED='false';
  try {await cleanup();} catch(e) {console.error('ATTENZIONE: cleanup manuale necessario: node tests\\test-popbus-ar-orchestrator-commit.cjs --cleanup');throw e;}
 }
 if(completed) console.log('PASS: test COMMIT reale A/R, idempotenza e cleanup');
}
main().catch(e=>{console.error('STOP:',e.code||'',e.message);process.exitCode=1;});
