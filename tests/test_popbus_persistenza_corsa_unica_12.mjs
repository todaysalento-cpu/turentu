// TURENTU POPBUS V2 — TEST 12: CONTRATTO PERSISTENZA CICLO MULTI-MISSIONE
// SOLA LETTURA: nessun collegamento DB, nessuna scrittura, nessun pagamento.
// Salva come tests/test_popbus_persistenza_corsa_unica_12.mjs
// Esegui: node tests/test_popbus_persistenza_corsa_unica_12.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const root=process.cwd();
const paths={
  worker:path.join(root,'services/popbus/v2/worker.js'),
  assembler:path.join(root,'services/popbus/v2/popbus-single-corsa-assembler.js'),
  persistence:path.join(root,'services/popbus/v2/popbus-cycle-persistence.js'),
  acceptance:path.join(root,'services/popbus/v2/acceptance.js')
};
let pass=0,fail=0,gap=0;
const check=(name,fn)=>{try{fn();pass++;console.log('PASS',name);}catch(e){fail++;console.log('FAIL',name,'—',e.message);}};
const note=(name,detail)=>{gap++;console.log('GAP',name,'—',detail);};
console.log('=== TURENTU POPBUS / TEST 12 CONTRATTO PERSISTENZA CORSA UNICA ===');
for(const [name,file] of Object.entries(paths)) check(`File presente: ${name}`,()=>assert(fs.existsSync(file),file));
if(Object.values(paths).some(p=>!fs.existsSync(p))){process.exitCode=1;console.log('STOP: mancano file necessari');}
else {
 const worker=fs.readFileSync(paths.worker,'utf8');
 const assembler=fs.readFileSync(paths.assembler,'utf8');
 const persistence=fs.readFileSync(paths.persistence,'utf8');
 const acceptance=fs.readFileSync(paths.acceptance,'utf8');
 check('Assembler espone composizione globale',()=>assert.match(assembler,/export\s+function\s+componiCicloInCorsa\s*\(/));
 check('Assembler conserva validazione capienza',()=>assert.match(assembler,/validazioneCapienza/));
 check('Assembler mantiene attivabile false',()=>assert.match(assembler,/attivabile\s*:\s*false/));
 check('Worker registra missioni nel percorso mono-missione',()=>assert.match(worker,/await\s+registraMissioniAttivazione\s*\(/));
 check('Worker genera cicli PIXEL diagnostici separatamente',()=>assert.match(worker,/async\s+function\s+eseguiCicliPixelShadow\s*\(/));
 check('Acceptance blocca cicli multi-missione',()=>assert.match(acceptance,/plan\.missioni\.length\s*>\s*1[\s\S]{0,180}throw\s+new\s+Error/));
 check('Acceptance crea la corsa nella tabella corse',()=>assert.match(acceptance,/INSERT\s+INTO\s+corse\s*\(/i));
 check('Persistenza missioni usa tabelle relazionali',()=>{
   assert.match(persistence,/INSERT\s+INTO\s+public\.popbus_attivazione_missioni/i);
   assert.match(persistence,/INSERT\s+INTO\s+public\.popbus_missione_richieste/i);
 });
 check('Persistenza non crea direttamente corse o pagamenti',()=>{
   assert.doesNotMatch(persistence,/INSERT\s+INTO\s+(?:public\.)?(?:corse|pagamenti|prenotazioni)\b/i);
 });
 const {registraMissioniAttivazione}=await import(pathToFileURL(paths.persistence).href);
 const ms=(h,m=0)=>Date.UTC(2026,9,19,h,m);
 const missioni=[
  {corridoioPixelId:11,nodes:[7,5],legs:[{metres:10000,seconds:1200,polyline:'abc'}],departure:ms(8),arrival:ms(8,20),requests:[{id:101,start:0,end:1,posti_richiesti:2}]},
  {corridoioPixelId:12,nodes:[5,8],legs:[{metres:10000,seconds:1200,polyline:'def'}],departure:ms(8,40),arrival:ms(9),requests:[{id:102,start:0,end:1,posti_richiesti:3}]},
  {corridoioPixelId:13,nodes:[8,7],legs:[{metres:10000,seconds:1200,polyline:'ghi'}],departure:ms(9,20),arrival:ms(9,40),requests:[{id:103,start:0,end:1,posti_richiesti:2}]}
 ];
 function fakeClient(){
  const calls=[];let next=1001;
  return {calls,async query(sql,params){
    assert(/^\s*INSERT\s+INTO\s+public\.popbus_(?:attivazione_missioni|missione_richieste)\b/i.test(sql),'Query inattesa nel mock');
    calls.push({sql,params});
    if(/popbus_attivazione_missioni/i.test(sql)) return {rows:[{id:next++}]};
    return {rows:[]};
  }};
 }
 const client=fakeClient();let ids=[];
 // Le verifiche asincrone usano un wrapper separato.
 async function asyncCheck(name,fn){try{await fn();pass++;console.log('PASS',name);}catch(e){fail++;console.log('FAIL',name,'—',e.message);}}
 await asyncCheck('Persistenza reale: tre missioni registrate in mock SQL',async()=>{
   ids=await registraMissioniAttivazione(client,{attivazioneId:501,missioni});
   assert.deepEqual(ids,[1001,1002,1003]);
 });
 check('Tre record missione e tre associazioni richiesta',()=>{
  assert.equal(client.calls.length,6);
  assert.equal(client.calls.filter(c=>/popbus_attivazione_missioni/i.test(c.sql)).length,3);
  assert.equal(client.calls.filter(c=>/popbus_missione_richieste/i.test(c.sql)).length,3);
 });
 check('Tutte le missioni puntano alla stessa attivazione',()=>{
  for(const c of client.calls.filter(c=>/popbus_attivazione_missioni/i.test(c.sql)))assert.equal(c.params[0],501);
 });
 check('Ordine missioni e ID richieste corretti',()=>{
  const m=client.calls.filter(c=>/popbus_attivazione_missioni/i.test(c.sql));
  assert.deepEqual(m.map(c=>c.params[1]),[1,2,3]);
  const r=client.calls.filter(c=>/popbus_missione_richieste/i.test(c.sql));
  assert.deepEqual(r.map(c=>c.params[1]),[101,102,103]);
 });
 check('Indici missione locali 0→1 preservati',()=>{
  const r=client.calls.filter(c=>/popbus_missione_richieste/i.test(c.sql));
  assert(r.every(c=>c.params[2]===0&&c.params[3]===1));
 });
 await asyncCheck('Richiesta duplicata tra missioni rifiutata',async()=>{
  const bad=structuredClone(missioni);bad[2].requests[0].id=101;
  await assert.rejects(()=>registraMissioniAttivazione(fakeClient(),{attivazioneId:501,missioni:bad}),/duplicat/i);
 });
 await asyncCheck('Missioni temporalmente sovrapposte rifiutate',async()=>{
  const bad=structuredClone(missioni);bad[1].departure=ms(8,10);
  await assert.rejects(()=>registraMissioniAttivazione(fakeClient(),{attivazioneId:501,missioni:bad}),/sovrappost|intervallo/i);
 });
 await asyncCheck('Indici locali invalidi rifiutati',async()=>{
  const bad=structuredClone(missioni);bad[0].requests[0].end=3;
  await assert.rejects(()=>registraMissioniAttivazione(fakeClient(),{attivazioneId:501,missioni:bad}),/indici/i);
 });
 note('Corsa unica non persistita dal modulo missioni','Il modulo registra missioni e associazioni a una attivazione, ma non inserisce la singola riga corse. Serve progettare e testare il collegamento transazionale.');
 note('Indici globali non persistiti dal modulo missioni','Le associazioni popbus_missione_richieste conservano indici locali; occorre definire mapping globale in popbus_attivazione_richieste e fermate.');
 note('Schema PostgreSQL non verificato','Il test usa mock SQL, non information_schema né vincoli/foreign key del DB reale.');
 note('Acceptance multi-missione intenzionalmente bloccata','Nessuna accettazione multi-missione deve essere abilitata in questa fase.');
}
console.log('\nRIEPILOGO',JSON.stringify({pass,fail,gap,modalita:'SOLA LETTURA / SQL MOCK',nota:'GAP sono aree ancora da implementare/collaudare, non PASS.'},null,2));
console.log(`ESITO: ${pass} PASS, ${fail} FAIL, ${gap} GAP. Nessuna scrittura.`);
if(fail)process.exitCode=1;
