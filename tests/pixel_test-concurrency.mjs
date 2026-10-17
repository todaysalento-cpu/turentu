import assert from 'node:assert/strict';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let routingCalls = 0;
let failOnce = false;
const routeNodes = async nodes => {
  routingCalls++;
  await delay(8);
  if (failOnce) { failOnce = false; throw Error('routing failure'); }
  return {verificataRouting:true, legs:nodes.slice(1).map((n,i)=>({metres:15000,seconds:1800,polyline:`route-${nodes[i]}-${n}`}))};
};
const req = (id,a,b,time='09:00') => ({id,origine_nodo_territoriale_id:a,destinazione_nodo_territoriale_id:b,start_datetime:`2026-10-16T${time}:00Z`,posti_richiesti:1});
let passed=0;
const test=async (name,fn)=>{await fn();console.log(`OK ${++passed}: ${name}`);};
await test('richieste simultanee stessa tratta non creano doppia direttrice',async()=>{
  const e=createIncrementalCorridorEngine({routeNodes});
  await Promise.all(Array.from({length:15},(_,i)=>e.processRequest(req(i+1,6,5))));
  assert.equal(e.listCorridors().length,1);
  assert.equal(e.listCorridors()[0].richiestaIds.length,15);
});
await test('duplicati concorrenti sono idempotenti',async()=>{
  const e=createIncrementalCorridorEngine({routeNodes});
  const results=await Promise.all(Array.from({length:8},()=>e.processRequest(req(100,6,5))));
  assert.equal(results.filter(x=>x.azione==='creazione').length,1);
  assert.equal(results.filter(x=>x.azione==='gia_presente').length,7);
});
await test('ID concorrente con dati differenti rifiutato',async()=>{
  const e=createIncrementalCorridorEngine({routeNodes});
  const results=await Promise.allSettled([e.processRequest(req(101,6,5)),e.processRequest(req(101,6,7))]);
  assert.equal(results[0].status,'fulfilled');
  assert.equal(results[1].status,'rejected');
});
await test('coda prosegue dopo errore di routing',async()=>{
  const e=createIncrementalCorridorEngine({routeNodes});
  failOnce=true;
  const results=await Promise.allSettled([e.processRequest(req(201,9,10)),e.processRequest(req(202,6,5))]);
  assert.equal(results[0].status,'rejected');
  assert.equal(results[1].status,'fulfilled');
  assert.equal(e.listCorridors().length,1);
});
await test('annullamento asincrono rispetta la sequenza',async()=>{
  const e=createIncrementalCorridorEngine({routeNodes});
  const add=e.processRequest(req(301,6,5));
  const remove=e.detachRequestAsync(301);
  await add;
  assert.equal(await remove,true);
  assert.equal(e.getRequest(301),null);
});
await test('annullamento sincrono bloccato durante mutazioni in corso',async()=>{
  const e=createIncrementalCorridorEngine({routeNodes});
  await e.processRequest(req(401,6,5));
  const add=e.processRequest(req(402,5,7));
  assert.throws(()=>e.detachRequest(401),/detachRequestAsync/);
  await add;
  assert.equal(e.detachRequest(401),true);
});
await test('lettura asincrona riparte dopo invalidazione',async()=>{
  const e=createIncrementalCorridorEngine({routeNodes});
  await e.processRequest(req(501,6,5));
  await e.processRequest(req(502,6,7));
  await e.processRequest(req(503,5,6,'09:45'));
  const c=e.listCorridors().find(x=>x.nodes.join('>')==='6>5>7');
  const promise=e.temporalCandidatesCompleteWithReturns(c.id,{bufferMinuti:10});
  await delay(2);
  assert.equal(e.detachRequest(503),true);
  const result=await promise;
  assert.ok(result.every(inst=>Object.values(inst.finestreRitornoPerNodo).flat().every(w=>!w.richiestaIds.includes(503))));
});
await test('coda svuotata dopo operazioni concorrenti',async()=>{
  const e=createIncrementalCorridorEngine({routeNodes});
  await Promise.all([e.processRequest(req(601,6,5)),e.processRequest(req(602,5,7)),e.detachRequestAsync(601)]);
  assert.equal(e.mutationQueueState().pending,0);
  assert.equal(e.getRequest(601),null);
});
console.log(`PIXEL CONCURRENCY: ${passed} test superati; DB intatto`);
