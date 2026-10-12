import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
async function moduleFile(path) {
  const s=await readFile(new URL(path,import.meta.url),'utf8');
  return import('data:text/javascript;base64,'+Buffer.from(s).toString('base64'));
}
const {calcolaPicco}=await moduleFile('../utils/occupazione.util.js');
const {analizzaPercorso}=await moduleFile('../services/popbus/economicEngine.js');
test('posti riutilizzati alla fermata: 2+2 sequenziali e 2 continui hanno picco 4',()=>{
  assert.equal(calcolaPicco([{start:0,end:10,posti:2},{start:10,end:20,posti:2},{start:0,end:20,posti:2}]),4);
});
test('prima prenotazione conta tutti i posti',()=>{
  assert.equal(calcolaPicco([{start:0,end:10,posti:7}]),7);
});
test('picco limitato alla tratta richiesta',()=>{
  assert.equal(calcolaPicco([{start:0,end:10,posti:7},{start:10,end:20,posti:2}],10,20),2);
});
test('intervalli inversi o passeggeri frazionari esclusi',()=>{
  assert.throws(()=>calcolaPicco([{start:10,end:0,posti:2}]));
  assert.throws(()=>calcolaPicco([{start:0,end:10,posti:1.5}]));
});
const segments=[{id:1,start_node_id:1,end_node_id:3,ordine_sequenziale:1,tempo_stimato:10},
  {id:2,start_node_id:3,end_node_id:4,ordine_sequenziale:2,tempo_stimato:10}];
const requests=[{id:1,start_node_id:1,end_node_id:4,start_datetime:'2026-10-12T17:00:00Z',posti_richiesti:2,prezzo:15},
  {id:2,start_node_id:3,end_node_id:4,start_datetime:'2026-10-12T17:05:00Z',posti_richiesti:1,prezzo:5}];
test('transiti e occupazione dei due segmenti',()=>{
  const p=analizzaPercorso(segments,requests,'2026-10-12T17:00:00Z');
  assert.deepEqual(p.segmenti.map(s=>s.occupazione),[2,3]);
  assert.deepEqual(p.segmenti.map(s=>s.ricavo),[15,20]);
  assert.equal(p.picco,3);
  assert.equal(p.segmenti[1].transito.toISOString(),'2026-10-12T17:10:00.000Z');
});
test('tolleranza salita inclusiva ±30 minuti',()=>{
  for(const t of ['16:40:00','17:40:00']) assert.doesNotThrow(()=>analizzaPercorso(segments,
    [{...requests[1],start_datetime:`2026-10-12T${t}Z`}],'2026-10-12T17:00:00Z'));
  assert.throws(()=>analizzaPercorso(segments,[{...requests[1],start_datetime:'2026-10-12T17:40:01Z'}],'2026-10-12T17:00:00Z'));
});
