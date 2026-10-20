// Eseguire da project-root: node tests/test_pixel_persistence_v2.js
// Importa il modulo reale in services/popbus/v2; usa SOLO un client mock.
import assert from 'node:assert/strict';
import { registraMissioniAttivazione } from '../services/popbus/v2/popbus-cycle-persistence.js';
const base = { nodes:[1,2], legs:[{metres:1000,seconds:60,polyline:'x'}], requests:[{id:101,start:0,end:1}], departure:'2026-11-01T10:00:00Z', arrival:'2026-11-01T10:01:00Z', pixelOpportunitaId:51, corridoioPixelId:'territorial:1>2', pixelDirettriceId:9, pixelVersione:2 };
function mock(overrides={}) {
  const queries=[];
  const db={queries, async query(sql,params){ queries.push({sql,params});
    if(sql.includes('FROM public.pixel_opportunita o')) return {rows:[{id:51,opportunita_stato:overrides.stato??'candidata',direttrice_id:9,direttrice_stato:'attiva',nodi:overrides.nodi??[1,2],engine_id:'territorial:1>2',versione:2}]};
    if(sql.includes('FROM public.pixel_opportunita_richieste')) return {rows:(overrides.richieste??[101]).map(richiesta_id=>({richiesta_id}))};
    if(sql.includes('INSERT INTO public.popbus_attivazione_missioni')) return {rows:[{id:71}]};
    return {rows:[]};
  }};return db;
}
let ok=0;
const run=async(name,fn)=>{await fn();console.log('PASS',name);ok++};
await run('PIXEL salva ID opportunita, nessuna direttrice legacy',async()=>{
 const db=mock(); const ids=await registraMissioniAttivazione(db,{attivazioneId:10,missioni:[base]});assert.deepEqual(ids,[71]);const q=db.queries.find(x=>x.sql.includes('INSERT INTO public.popbus_attivazione_missioni'));assert.equal(q.params[2],null);assert.equal(q.params[8],51);assert.equal(q.params[3],'territorial:1>2');
});
await run('opportunita superata: nessuna scrittura',async()=>{
 const db=mock({stato:'superata'});await assert.rejects(()=>registraMissioniAttivazione(db,{attivazioneId:10,missioni:[base]}),/non attiva/);assert(!db.queries.some(q=>q.sql.includes('INSERT')));
});
await run('richiesta estranea: nessuna scrittura',async()=>{
 const db=mock({richieste:[102]});await assert.rejects(()=>registraMissioniAttivazione(db,{attivazioneId:10,missioni:[base]}),/non associate/);assert(!db.queries.some(q=>q.sql.includes('INSERT')));
});
await run('nodi diversi: nessuna scrittura',async()=>{
 const db=mock({nodi:[1,3]});await assert.rejects(()=>registraMissioniAttivazione(db,{attivazioneId:10,missioni:[base]}),/nodi discordante/);assert(!db.queries.some(q=>q.sql.includes('INSERT')));
});
await run('missione legacy resta supportata',async()=>{
 const db=mock();await registraMissioniAttivazione(db,{attivazioneId:10,missioni:[{...base,pixelOpportunitaId:null,corridoioPixelId:null,direttriceId:33}]});const q=db.queries.find(x=>x.sql.includes('INSERT INTO public.popbus_attivazione_missioni'));assert.equal(q.params[2],33);assert.equal(q.params[8],null);
});
console.log(`RISULTATO ${ok}/5 PASS (mock; nessun DB reale)`);
