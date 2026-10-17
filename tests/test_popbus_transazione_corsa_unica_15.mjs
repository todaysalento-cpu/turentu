// TURENTU POPBUS V2 — TEST 15 / CONTRATTO TRANSAZIONALE CORSA UNICA
// Salvare come tests/test_popbus_transazione_corsa_unica_15.mjs
// Eseguire: node tests/test_popbus_transazione_corsa_unica_15.mjs
// Nessuna connessione PostgreSQL, Stripe, socket o scrittura: SQL eseguito SOLO in mock.
// ATTENZIONE: il test NON abilita ne' esegue acceptance reale multi-missione.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let pass=0,fail=0,gap=0;
function ok(name,fn){try{fn();pass++;console.log('PASS',name);}catch(e){fail++;console.error('FAIL',name,'—',e.message);}}
async function asyncOk(name,fn){try{await fn();pass++;console.log('PASS',name);}catch(e){fail++;console.error('FAIL',name,'—',e.message);}}
function finding(name,description){gap++;console.log('GAP',name,'—',description);}
const root=process.cwd();
const pfile=path.join(root,'services/popbus/v2/popbus-cycle-persistence.js');
const afile=path.join(root,'services/popbus/v2/acceptance.js');
console.log('=== TURENTU POPBUS / TEST 15 TRANSAZIONE CORSA UNICA ===');
console.log('MODALITA: SQL MOCK / NESSUNA SCRITTURA REALE / NESSUNA CHIAMATA STRIPE');
if(!fs.existsSync(pfile)||!fs.existsSync(afile)){
 console.error('FAIL File richiesti assenti:',pfile,afile);process.exitCode=1;
}else{
 const {registraMissioniAttivazione}=await import(pathToFileURL(pfile).href);
 const acceptance=fs.readFileSync(afile,'utf8');
 const base=Date.parse('2026-10-19T08:00:00.000Z');
 const minutes=n=>new Date(base+n*60000);
 const missions=[
  {nodes:[7,5],legs:[{metres:10000,seconds:1200,polyline:'abc'}],departure:minutes(0),arrival:minutes(20),requests:[{id:101,start:0,end:1,posti_richiesti:2}]},
  {nodes:[5,8],legs:[{metres:12000,seconds:1200,polyline:'def'}],departure:minutes(40),arrival:minutes(60),requests:[{id:102,start:0,end:1,posti_richiesti:3}]},
  {nodes:[8,7],legs:[{metres:11000,seconds:1200,polyline:'ghi'}],departure:minutes(80),arrival:minutes(100),requests:[{id:103,start:0,end:1,posti_richiesti:2}]}
 ];
 const global=[{id:101,start:0,end:1,posti:2,cliente:11,prezzo:30},{id:102,start:3,end:4,posti:3,cliente:12,prezzo:40},{id:103,start:6,end:7,posti:2,cliente:13,prezzo:35}];
 const stops=[7,5,5,5,8,8,8,7];
 const offsets=[0,10000,10000,10000,22000,22000,22000,33000];
 function freshState(){return {activations:[],missions:[],missionRequests:[],activationRequests:[],rides:[],bookings:[],payments:[],requests:[]};}
 function clone(x){return structuredClone(x);}
 class MockDB {
  constructor(failAt=null){this.data=freshState();this.stage=null;this.trace=[];this.failAt=failAt;this.counter=0;this.ids={mission:1000,ride:2000,booking:3000};}
  async begin(){assert.equal(this.stage,null);this.stage=clone(this.data);this.trace.push('BEGIN');}
  async commit(){assert(this.stage);this.data=this.stage;this.stage=null;this.trace.push('COMMIT');}
  async rollback(){this.stage=null;this.trace.push('ROLLBACK');}
  async query(sql,params){
   assert(this.stage,'SQL senza transazione');
   const normalized=sql.replace(/\s+/g,' ').trim();
   const insert=normalized.match(/^INSERT INTO (?:public\.)?([a-z_]+)/i);
   assert(insert,'Mock accetta solo INSERT, ricevuto: '+normalized.slice(0,100));
   const table=insert[1];this.counter++;
   if(this.failAt===table)throw new Error('SIMULATED_SQL_FAILURE:'+table);
   const s=this.stage;
   if(table==='popbus_attivazioni'){
    assert.equal(params[0],501);s.activations.push({id:501,veicolo_id:353,corsa_id:null});return {rows:[{id:501}]};
   }
   if(table==='popbus_attivazione_missioni'){
    assert(s.activations.some(a=>a.id===Number(params[0])),'FK attivazione');
    assert(!s.missions.some(m=>m.attivazione_id===params[0]&&m.ordine===params[1]),'UNIQUE ordine');
    const id=++this.ids.mission;
    s.missions.push({id,attivazione_id:Number(params[0]),ordine:params[1],nodes:params[4],departure:new Date(params[5]).toISOString(),arrival:new Date(params[6]).toISOString(),piano:JSON.parse(params[7])});
    return {rows:[{id}]};
   }
   if(table==='popbus_missione_richieste'){
    assert(s.missions.some(m=>m.id===Number(params[0])),'FK missione');
    assert(params[3]>params[2]&&params[2]>=0,'CHECK indici locali');
    s.missionRequests.push({missione_id:Number(params[0]),richiesta_id:Number(params[1]),start:params[2],end:params[3]});return {rows:[]};
   }
   if(table==='popbus_attivazione_richieste'){
    assert(s.activations.some(a=>a.id===Number(params[0])),'FK attivazione');
    assert(params[3]>params[2],'CHECK indici globali');
    assert(!s.activationRequests.some(r=>r.richiesta_id===Number(params[1])),'UNIQUE richiesta attiva');
    s.activationRequests.push({attivazione_id:Number(params[0]),richiesta_id:Number(params[1]),start:params[2],end:params[3]});return {rows:[]};
   }
   if(table==='corse'){
    const id=++this.ids.ride;s.rides.push({id,veicolo_id:353,stops:params[0]});return {rows:[{id}]};
   }
   if(table==='prenotazioni'){
    assert(s.rides.some(c=>c.id===Number(params[0])),'FK corsa');
    const id=++this.ids.booking;
    s.bookings.push({id,corsa_id:Number(params[0]),cliente_id:params[1],posti:params[2],start:params[3],end:params[4],start_offset:params[5],end_offset:params[6]});return {rows:[{id}]};
   }
   if(table==='pagamenti'){
    assert(s.bookings.some(b=>b.id===Number(params[0])),'FK prenotazione');
    assert(s.rides.some(c=>c.id===Number(params[1])),'FK corsa');
    assert(!s.payments.some(p=>p.prenotazione_id===Number(params[0])),'UNIQUE pagamento per prenotazione');
    s.payments.push({prenotazione_id:Number(params[0]),corsa_id:Number(params[1]),importo:params[2],stato:'autorizzazione'});return {rows:[]};
   }
   throw new Error('Tabella SQL non prevista: '+table);
  }
 }
 const sql={
  activation:'INSERT INTO public.popbus_attivazioni (id) VALUES ($1) RETURNING id',
  association:'INSERT INTO public.popbus_attivazione_richieste (attivazione_id,richiesta_id,indice_salita,indice_discesa) VALUES ($1,$2,$3,$4)',
  ride:'INSERT INTO public.corse (fermate_pianificate) VALUES ($1) RETURNING id',
  booking:'INSERT INTO public.prenotazioni (corsa_id,cliente_id,posti_richiesti,start_index_polyline,end_index_polyline,start_offset,end_offset) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
  payment:'INSERT INTO public.pagamenti (prenotazione_id,corsa_id,importo) VALUES ($1,$2,$3)'
 };
 // Questa e' un'orchestrazione DIAGNOSTICA del contratto, NON il codice di produzione.
 async function simulate(db,{duplicate=false,invalidGlobal=false}={}){
  await db.begin();
  try{
   await db.query(sql.activation,[501]);
   await registraMissioniAttivazione(db,{attivazioneId:501,missioni:missions});
   const requests=clone(global);
   if(duplicate)requests[2].id=101;
   if(invalidGlobal)requests[1].end=requests[1].start;
   for(const r of requests)await db.query(sql.association,[501,r.id,r.start,r.end]);
   const {rows:[ride]}=await db.query(sql.ride,[stops]);
   db.stage.activations[0].corsa_id=ride.id; // simulazione link, non UPDATE SQL reale
   for(const r of requests){
    const {rows:[b]}=await db.query(sql.booking,[ride.id,r.cliente,r.posti,r.start,r.end,offsets[r.start],offsets[r.end]]);
    await db.query(sql.payment,[b.id,ride.id,r.prezzo]);
   }
   await db.commit();return db;
  }catch(e){await db.rollback();throw e;}
 }
 let success;
 await asyncOk('Transazione simulata: tre missioni, una corsa, tre prenotazioni e pagamenti',async()=>{success=await simulate(new MockDB());
  assert.equal(success.data.activations.length,1);assert.equal(success.data.missions.length,3);
  assert.equal(success.data.missionRequests.length,3);assert.equal(success.data.activationRequests.length,3);
  assert.equal(success.data.rides.length,1);assert.equal(success.data.bookings.length,3);assert.equal(success.data.payments.length,3);
 });
 if(success){
  ok('Unico ID corsa per tutte le prenotazioni',()=>assert.equal(new Set(success.data.bookings.map(x=>x.corsa_id)).size,1));
  ok('Unico ID corsa per tutti i pagamenti',()=>assert.equal(new Set(success.data.payments.map(x=>x.corsa_id)).size,1));
  ok('Tre missioni collegate alla stessa attivazione',()=>assert.deepEqual(success.data.missions.map(x=>x.attivazione_id),[501,501,501]));
  ok('Ordine missioni 1, 2, 3 e nodi preservati',()=>{assert.deepEqual(success.data.missions.map(x=>x.ordine),[1,2,3]);assert.deepEqual(success.data.missions.map(x=>x.nodes),[[7,5],[5,8],[8,7]]);});
  ok('Indici locali missione 0→1 invariati',()=>assert(success.data.missionRequests.every(x=>x.start===0&&x.end===1)));
  ok('Indici globali 0→1 / 3→4 / 6→7',()=>assert.deepEqual(success.data.activationRequests.map(x=>[x.start,x.end]),[[0,1],[3,4],[6,7]]));
  ok('Prenotazioni puntano a indici globali distinti',()=>assert.deepEqual(success.data.bookings.map(x=>[x.start,x.end]),[[0,1],[3,4],[6,7]]));
  ok('Offset progressivi coerenti con le fermate',()=>assert.deepEqual(success.data.bookings.map(x=>[x.start_offset,x.end_offset]),[[0,10000],[10000,22000],[22000,33000]]));
  ok('Tre pagamenti distinti, uno per prenotazione',()=>assert.equal(new Set(success.data.payments.map(x=>x.prenotazione_id)).size,3));
  ok('Importi e somma pagamenti conservati',()=>assert.equal(success.data.payments.reduce((n,p)=>n+p.importo,0),105));
  ok('Link attivazione → corsa unica',()=>assert.equal(success.data.activations[0].corsa_id,success.data.rides[0].id));
  ok('Commit effettuato una sola volta',()=>assert.deepEqual(success.trace.filter(x=>x==='COMMIT'),['COMMIT']));
 }
 for(const table of ['popbus_attivazione_missioni','popbus_missione_richieste','popbus_attivazione_richieste','corse','prenotazioni','pagamenti']){
  await asyncOk('Rollback atomico su errore '+table,async()=>{
   const db=new MockDB(table);
   await assert.rejects(()=>simulate(db),new RegExp('SIMULATED_SQL_FAILURE:'+table));
   assert.deepEqual(db.data,freshState());assert.equal(db.stage,null);
   assert.equal(db.trace.at(-1),'ROLLBACK');assert(!db.trace.includes('COMMIT'));
  });
 }
 await asyncOk('Rollback su richiesta duplicata globale',async()=>{const db=new MockDB();await assert.rejects(()=>simulate(db,{duplicate:true}),/UNIQUE richiesta attiva/);assert.deepEqual(db.data,freshState());});
 await asyncOk('Rollback su indice globale discesa non successivo',async()=>{const db=new MockDB();await assert.rejects(()=>simulate(db,{invalidGlobal:true}),/CHECK indici globali/);assert.deepEqual(db.data,freshState());});
 ok('Acceptance reale contiene INSERT in corse',()=>assert.match(acceptance,/INSERT\s+INTO\s+(?:public\.)?corse\s*\(/i));
 ok('Acceptance reale contiene INSERT in prenotazioni',()=>assert.match(acceptance,/INSERT\s+INTO\s+(?:public\.)?prenotazioni\s*\(/i));
 ok('Acceptance reale contiene INSERT in pagamenti',()=>assert.match(acceptance,/INSERT\s+INTO\s+(?:public\.)?pagamenti\s*\(/i));
 ok('Guardia acceptance multi-missione ancora presente',()=>assert.match(acceptance,/plan\.missioni\.length\s*>\s*1[\s\S]{0,180}throw\s+new\s+Error/));
 ok('La persistenza missioni non apre transazioni proprie',()=>{const code=fs.readFileSync(pfile,'utf8');assert.doesNotMatch(code,/\b(?:BEGIN|COMMIT|ROLLBACK)\b\s*['"`]/i);});
 finding('Acceptance multi-missione non eseguita','La guardia reale blocca ancora il ciclo; il test usa un orchestratore SQL mock separato.');
 finding('Transazione PostgreSQL reale non verificata','Rollback e vincoli sono simulati in memoria, non esercitati contro PostgreSQL.');
 finding('Stripe e capture non esercitati','Nessuna chiamata API Stripe; importi e stati sono dati sintetici.');
 finding('Link e geometria reali non eseguiti','UPDATE attivazione.corsa_id e conversione delle richieste sono simulati; polilinee e offset reali restano da verificare.');
}
console.log('\nRIEPILOGO',JSON.stringify({pass,fail,gap,modalita:'SQL MOCK / ZERO SCRITTURE / ZERO STRIPE'},null,2));
console.log(`ESITO: ${pass} PASS, ${fail} FAIL, ${gap} GAP. Nessuna scrittura.`);
if(fail)process.exitCode=1;
