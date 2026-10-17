import assert from 'node:assert/strict';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';

let routingCalls = 0;
const routeNodes = async nodes => {
  routingCalls++;
  return { verificataRouting:true, legs:nodes.slice(1).map((n,i)=>({
    metres:15000,seconds:1800,polyline:`mock-${nodes[i]}-${n}`
  })) };
};
const r=(id,a,b,h,m)=>({id,origine_nodo_territoriale_id:a,destinazione_nodo_territoriale_id:b,
  start_datetime:new Date(Date.UTC(2026,9,16,h,m)).toISOString(),posti_richiesti:1});
let count=0;
async function test(name,fn){await fn();console.log(`OK ${++count}: ${name}`);}
const engine=createIncrementalCorridorEngine({routeNodes,tolleranzaMinuti:15});
await engine.processRequest(r(1,6,5,9,0));
await engine.processRequest(r(2,6,7,9,20));
await engine.processRequest(r(3,6,7,9,40));
await engine.processRequest(r(7,6,7,9,0));
await engine.processRequest(r(4,5,6,10,30));
await engine.processRequest(r(5,5,6,11,30));
const corridor=engine.listCorridors().find(c=>c.nodes.join('>')==='6>5>7');
assert.ok(corridor);
const cid=corridor.id;
const opts={bufferMinuti:10};
const get=()=>engine.temporalCandidatesCompleteWithReturns(cid,opts);
await test('istanze massimali complete senza perdita della richiesta ponte',async()=>{
  const got=await get();
  assert.deepEqual(got.map(x=>x.richiestaIds),[[2,7],[2,3]]);
  assert.ok(got.every(x=>x.massimaleTemporale===true));
});
await test('ogni alternativa contiene il proprio indice finestre per nodo',async()=>{
  const got=await get();
  for(const x of got){
    assert.ok(Array.isArray(x.finestreRitornoPerNodo[5]));
    assert.ok(x.finestreRitornoPerNodo[5].some(w=>w.inversioneNodoId===5));
    assert.ok(x.finestreRitornoPerNodo[5].some(w=>w.inversioneNodoId===7));
  }
});
await test('nessuna finestra duplicata nella stessa istanza',async()=>{
  for(const x of await get()) for(const windows of Object.values(x.finestreRitornoPerNodo)){
    const keys=windows.map(w=>JSON.stringify([w.inversioneNodoId,w.nodoSalitaId,w.richiestaIds,w.finestraInizioRitorno]));
    assert.equal(new Set(keys).size,keys.length);
  }
});
await test('cache completa riutilizzata senza nuovo routing',async()=>{
  const before=await get(); const n=routingCalls;
  assert.strictEqual(await get(),before);
  assert.equal(routingCalls,n);
});
await test('cache V1 separata dalla cache completa',async()=>{
  const complete=await get(); const v1=await engine.temporalCandidatesWithReturns(cid,opts);
  assert.notStrictEqual(v1,complete);
  assert.strictEqual(await get(),complete);
});
await test('richiesta inversa invalida la cache completa',async()=>{
  const old=await get();
  await engine.processRequest(r(6,5,6,12,30));
  const updated=await get();
  assert.notStrictEqual(updated,old);
  assert.ok(updated.some(x=>x.finestreRitornoPerNodo[5].some(w=>w.richiestaIds.includes(6))));
});
await test('annullamento elimina la richiesta inversa dalle finestre',async()=>{
  engine.detachRequest(6);
  assert.ok((await get()).every(x=>Object.values(x.finestreRitornoPerNodo).flat().every(w=>!w.richiestaIds.includes(6))));
});
await test('annullamento della richiesta ponte aggiorna gruppi e ritorni',async()=>{
  engine.detachRequest(2);
  assert.deepEqual((await get()).map(x=>x.richiestaIds),[[7],[3]]);
});
await test('nessuna prenotazione anticipata: richiesta condivisa resta disponibile',async()=>{
  assert.ok(engine.getRequest(4));
  assert.ok(engine.getRequest(5));
  assert.ok(engine.getRequest(1));
  assert.ok(engine.getRequest(3));
});
console.log(`PIXEL UNIFIED TEMPORAL RETURNS: ${count} test superati; DB intatto`);
