import assert from 'node:assert/strict';
import { preparaInputFattibilitaPixel } from '../services/popbus/v2/pixel-worker-feasibility-bridge.js';
const base = () => ({
  richieste: [{id: 11, stato:'in_attesa', corsa_id:null, start_node_id:1,end_node_id:3,start_datetime:new Date(1_800_000_060_000).toISOString()}],
  nodi: [{id:1,lat:40,lon:18},{id:2,lat:40.1,lon:18.1},{id:3,lat:40.2,lon:18.2}],
  formazioni: [{source:'PIXEL',pixelOpportunitaId:9,pixelDirettriceId:8,pixelVersione:2,richiestaIds:[11],
    plan:{nodes:[1,2,3],legs:[{seconds:60,metres:1000,polyline:'abc'},{seconds:60,metres:1000,polyline:'def'}]},
    evaluation:{departure:1_800_000_060_000,arrival:1_800_000_180_000,times:[0,60_000,120_000],peak:1,revenue:10,requests:[{id:11,start:0,end:2}]}}]
});
let count=0;
function pass(name,fn){fn();count++;console.log('PASS',name);}
function reject(name,fn){pass(name,()=>assert.throws(fn,/PIXEL_FEASIBILITY_BRIDGE/));}
pass('input PIXEL valido',()=>{const x=base();const [v]=preparaInputFattibilitaPixel(x.formazioni,x.richieste,x.nodi);assert.equal(v.selectedRequests[0].id,11);assert.equal(v.coordinates.length,3);});
reject('origine non PIXEL',()=>{const x=base();x.formazioni[0].source='LEGACY';preparaInputFattibilitaPixel(x.formazioni,x.richieste,x.nodi);});
reject('nodo intermedio mancante',()=>{const x=base();x.nodi.splice(1,1);preparaInputFattibilitaPixel(x.formazioni,x.richieste,x.nodi);});
reject('richiesta non disponibile',()=>{const x=base();x.richieste[0].stato='convertita';preparaInputFattibilitaPixel(x.formazioni,x.richieste,x.nodi);});
reject('tratta senza routing',()=>{const x=base();x.formazioni[0].plan.legs[0].seconds=0;preparaInputFattibilitaPixel(x.formazioni,x.richieste,x.nodi);});
reject('tempi incoerenti',()=>{const x=base();x.formazioni[0].evaluation.times[1]=80_000;preparaInputFattibilitaPixel(x.formazioni,x.richieste,x.nodi);});
reject('richiesta estranea',()=>{const x=base();x.formazioni[0].richiestaIds=[12];preparaInputFattibilitaPixel(x.formazioni,x.richieste,x.nodi);});
reject('salita sbagliata',()=>{const x=base();x.formazioni[0].evaluation.requests[0].start=1;preparaInputFattibilitaPixel(x.formazioni,x.richieste,x.nodi);});
reject('fuori tolleranza al pickup',()=>{const x=base();x.richieste[0].start_datetime=new Date(1_800_004_000_000).toISOString();preparaInputFattibilitaPixel(x.formazioni,x.richieste,x.nodi);});
reject('valutazione incompleta',()=>{const x=base();delete x.formazioni[0].evaluation.peak;preparaInputFattibilitaPixel(x.formazioni,x.richieste,x.nodi);});
console.log(`RISULTATO: ${count}/10 PASS - bridge isolato, nessuna scrittura DB`);
