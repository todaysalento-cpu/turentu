import assert from 'node:assert/strict';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';

let routingCalls = 0;
const routeNodes = async nodes => {
  routingCalls++;
  return { verificataRouting:true, legs:nodes.slice(1).map((n,i)=>({
    metres:15000, seconds:1800, polyline:`mock-${nodes[i]}-${n}`
  })) };
};
const r = (id, a, b, time) => ({id, origine_nodo_territoriale_id:a,
  destinazione_nodo_territoriale_id:b,
  start_datetime:`2026-10-16T${time}:00Z`, posti_richiesti:1});
const e = createIncrementalCorridorEngine({routeNodes,tolleranzaMinuti:15});
let passed = 0;
async function test(label, fn) { await fn(); console.log(`OK ${++passed}: ${label}`); }
await e.processRequest(r(1,6,5,'09:00'));
await e.processRequest(r(2,6,7,'09:00'));
await e.processRequest(r(3,5,6,'09:45'));
await e.processRequest(r(4,5,6,'10:45'));
const corridor = e.listCorridors().find(c=>c.nodes.join('>')==='6>5>7');
assert.ok(corridor);
await test('cache temporale riutilizzata senza modifiche', async()=>{
  const first=await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10});
  const calls=routingCalls;
  const second=await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10});
  assert.strictEqual(second,first);
  assert.equal(routingCalls,calls);
});
await test('finestre distinte per inversione Maglie e Lecce', async()=>{
  const v=(await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10}))
    .flatMap(x=>x.finestreRitornoPerNodo[5]);
  assert.ok(v.some(x=>x.inversioneNodoId===5&&x.richiestaIds.includes(3)));
  assert.ok(v.some(x=>x.inversioneNodoId===7&&x.richiestaIds.includes(4)));
});
await test('nessuna finestra identica duplicata', async()=>{
  const instances=await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10});
  for (const instance of instances) for (const entries of Object.values(instance.finestreRitornoPerNodo)) {
    const keys=entries.map(w=>JSON.stringify([w.inversioneNodoId,w.nodoSalitaId,
      w.finestraInizioRitorno,w.richiestaIds]));
    assert.equal(new Set(keys).size,keys.length);
  }
});
await test('richieste temporalmente incompatibili mantengono opportunita distinte',async()=>{
  const windows=(await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10}))
    .flatMap(x=>x.finestreRitornoPerNodo[5]).filter(x=>x.inversioneNodoId===7);
  assert.ok(windows.length>=1);
  assert.ok(windows.every(w=>w.finestraPassaggio.inizioMs<=w.finestraPassaggio.fineMs));
});
await test('annullamento invalida cache e aggiorna opportunita',async()=>{
  const before=await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10});
  const revision=e.opportunityRevision(corridor.id);
  assert.equal(e.detachRequest(3),true);
  assert.ok(e.opportunityRevision(corridor.id)>revision);
  const after=await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10});
  assert.notStrictEqual(after,before);
  assert.ok(after.flatMap(x=>x.finestreRitornoPerNodo[5]).every(w=>!w.richiestaIds.includes(3)));
});
await test('una direttrice indipendente non invalida la cache',async()=>{
  const before=await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10});
  await e.processRequest(r(20,100,101,'11:00'));
  const after=await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10});
  assert.strictEqual(before,after);
});
await test('richiesta inversa pertinente invalida solo istanze coinvolte',async()=>{
  const before=await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10});
  await e.processRequest(r(21,5,6,'11:45'));
  const after=await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10});
  assert.notStrictEqual(before,after);
});
await test('eventi revisioni deduplicati e consumabili',async()=>{
  const changes=e.consumeOpportunityChanges();
  assert.ok(changes.some(x=>x.direttriceId===corridor.id));
  assert.equal(new Set(changes.map(x=>x.direttriceId)).size,changes.length);
  assert.deepEqual(e.consumeOpportunityChanges(),[]);
});
await test('richiesta identica non invalida cache',async()=>{
  const before=await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10});
  const revision=e.opportunityRevision(corridor.id);
  const result=await e.processRequest(r(21,5,6,'11:45'));
  assert.equal(result.azione,'gia_presente');
  assert.equal(e.opportunityRevision(corridor.id),revision);
  assert.strictEqual(await e.temporalCandidatesWithReturns(corridor.id,{bufferMinuti:10}),before);
});
console.log(`PIXEL INCREMENTAL CACHE: ${passed} test superati; nessuna scrittura DB`);
