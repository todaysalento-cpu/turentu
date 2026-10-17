import assert from 'node:assert/strict';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { gruppiTemporaliCompleti } from '../services/pixel/pixel-temporal-complete.js';
const r=(id,a,b,minute)=>({id,origine_nodo_territoriale_id:a,destinazione_nodo_territoriale_id:b,
  start_datetime:new Date(Date.UTC(2026,9,16,9,minute)).toISOString(),posti_richiesti:1});
const routeNodes=async nodes=>({verificataRouting:true,legs:nodes.slice(1).map((n,i)=>({
  metres:10000,seconds:1800,polyline:`mock-${nodes[i]}-${n}`}))});
let count=0;
const test=async(label,fn)=>{await fn();console.log(`OK ${++count}: ${label}`)};
const inputs=[r(1,6,7,0),r(2,6,7,20),r(3,6,7,40)];
const mk=async order=>{const e=createIncrementalCorridorEngine({routeNodes,tolleranzaMinuti:15});
  for(const i of order) await e.processRequest(inputs[i]);return e};
await test('ordine di arrivo non cambia i gruppi massimali',async()=>{
  const a=await mk([0,1,2]),b=await mk([2,0,1]);
  assert.deepEqual(a.temporalCandidatesComplete('px-1'),b.temporalCandidatesComplete('px-1'));
});
await test('richiesta ponte compare in due alternative senza prenotazione',async()=>{
  const e=await mk([0,1,2]);
  assert.deepEqual(e.temporalCandidatesComplete('px-1').map(g=>g.richiestaIds),[[1,2],[2,3]]);
});
await test('nessun gruppo incompatibile',async()=>{
  const e=await mk([0,1,2]);
  for(const g of e.temporalCandidatesComplete('px-1')) assert.ok(g.finestraPartenza.inizioMs<=g.finestraPartenza.fineMs);
});
await test('finestre che si toccano sono compatibili',async()=>{
  const q=[r(11,6,7,0),r(12,6,7,30)];
  const g=gruppiTemporaliCompleti({richieste:q,offsetSecondi:()=>0,tolleranzaMinuti:15});
  assert.deepEqual(g.map(x=>x.richiestaIds),[[11,12]]);
  assert.equal(g[0].finestraPartenza.inizioMs,g[0].finestraPartenza.fineMs);
});
await test('offset stradale normalizza orari di salita diversi',async()=>{
  const q=[r(21,6,7,0),r(22,5,7,30)];
  const g=gruppiTemporaliCompleti({richieste:q,offsetSecondi:x=>x.id===22?1800:0,tolleranzaMinuti:5});
  assert.deepEqual(g.map(x=>x.richiestaIds),[[21,22]]);
});
await test('separazione gruppi lontani',async()=>{
  const q=[r(31,6,7,0),r(32,6,7,40)];
  assert.equal(gruppiTemporaliCompleti({richieste:q,offsetSecondi:()=>0,tolleranzaMinuti:15}).length,2);
});
await test('rimozione richiesta ponte aggiorna alternative',async()=>{
  const e=await mk([0,1,2]);e.detachRequest(2);
  assert.deepEqual(e.temporalCandidatesComplete('px-1').map(x=>x.richiestaIds),[[1],[3]]);
});
await test('richieste duplicate rifiutate',async()=>{
  assert.throws(()=>gruppiTemporaliCompleti({richieste:[inputs[0],inputs[0]],offsetSecondi:()=>0}),/duplicata/);
});
await test('la funzione V1 rimane disponibile',async()=>{
  const e=await mk([0,1,2]);assert.ok(e.temporalCandidates('px-1').length>0);
});
console.log(`PIXEL TEMPORAL COMPLETE: ${count} test superati; DB intatto`);
