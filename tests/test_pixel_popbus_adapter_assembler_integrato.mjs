// TURENTU — test integrato PIXEL adapter -> POPBUS assembler (read-only)
// Salvare in tests/test_pixel_popbus_adapter_assembler_integrato.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticaCicloPixelPopbus } from '../services/pixel/pixel-popbus-cycle-adapter.js';
import { componiCicloInCorsa } from '../services/popbus/v2/popbus-single-corsa-assembler.js';

const T = Date.parse('2030-04-01T10:00:00Z');
const P = '_p~iF~ps|U_ulLnnqC_mqNvxq`@'; // stringa non vuota; routing sintetico
const nodi = [
  {id:1,lat:40.1,lon:18.1},{id:2,lat:40.2,lon:18.2},
  {id:3,lat:40.3,lon:18.3},{id:4,lat:40.4,lon:18.4}
];
const leg = (seconds=600,metres=3000) => ({seconds,metres,polyline:P,roadCoincident:false});
const vehicle = {id:10,driver_id:20,posti_totali:4,euro_km:0.5,lat:39.9,lon:17.9};
const req = (id,start_node_id,end_node_id,start_datetime,extra={}) => ({
  id,start_node_id,end_node_id,start_datetime:new Date(start_datetime).toISOString(),
  posti_richiesti:2,prezzo:100,classe:'STANDARD',...extra
});
function fixture({second=true,shared=false,waitMs=0,transferSeconds=300,transferMetres=1500}={}) {
  const m1 = {id:101,nodes:[1,2],legs:[leg()],richiestaIds:[11]};
  const m2 = {id:102,nodes:shared?[2,3]:[3,4],legs:[leg()],richiestaIds:[22]};
  const firstEnd=T+600000;
  const secondStart=firstEnd+(shared?0:transferSeconds*1000)+waitMs;
  const requests=[req(11,1,2,T)];
  if(second) requests.push(req(22,m2.nodes[0],m2.nodes[1],secondStart));
  const corridors=second?[m1,m2]:[m1];
  const cm=new Map(corridors.map(c=>[c.id,c]));
  const rm=new Map(requests.map(r=>[r.id,r]));
  const engine={getCorridor:id=>cm.get(id),getRequest:id=>rm.get(Number(id))};
  const road=async(a,b)=>{
    if(Number(a.id)===2 && Number(b.id)===3) return leg(transferSeconds,transferMetres);
    return leg(120,1000); // avvicinamento e ritorno, deterministici
  };
  return {engine,requests,corridors,road,secondStart,cm,rm};
}
async function diagnostic(f,{vehicleOverride={},requestIds=null,missionIds=null,validateVehicle=async()=>true,validateCandidate=async()=>true,now=T-3600000}={}) {
  const missioni=(missionIds??f.corridors.map(c=>c.id)).map((id,i)=>({
    corridorId:id,requestIds:requestIds?.[i]??[f.cm.get(id)?.richiestaIds[0]]
  }));
  return diagnosticaCicloPixelPopbus({
    engine:f.engine,missioni,richieste:f.requests,vehicle:{...vehicle,...vehicleOverride},
    nodes:nodi,road:f.road,now,validateVehicle,validateCandidate
  });
}
function assemble(d) {
  assert.equal(d.ok,true,`Adapter non valido: ${d.motivo||'sconosciuto'} ${d.dettaglio||''}`);
  assert.equal(d.validazionePreliminare,true);
  const p=componiCicloInCorsa({
    missioni:d.missioni,trasferimenti:d.trasferimenti,nodi,veicoloId:d.veicoloId,
    busyStart:d.busyStart,busyEnd:d.busyEnd,postiTotali:vehicle.posti_totali,
    approach:d.approach,returnTrip:d.returnTrip
  });
  assert.equal(p.attivabile,false);
  assert.equal(p.validazioneCapienza.verificata,true);
  assert.equal(p.nodes.length,p.legs.length+1);
  assert.equal(p.evaluation.times.length,p.nodes.length);
  assert.equal(p.evaluation.departure+p.evaluation.times.at(-1),p.evaluation.arrival);
  return p;
}

test('01 — una missione: adapter e assembler coerenti',async()=>{
  const p=assemble(await diagnostic(fixture({second:false})));
  assert.equal(p.missioni.length,1);assert.equal(p.evaluation.peak,2);
});
test('02 — due missioni e trasferimento stradale',async()=>{
  const p=assemble(await diagnostic(fixture()));
  assert.equal(p.missioni.length,2);
  assert.deepEqual(p.evaluation.requests.map(r=>[r.start,r.end]),[[0,1],[2,3]]);
});
test('03 — trasferimento con attesa di dieci minuti',async()=>{
  const p=assemble(await diagnostic(fixture({waitMs:600000})));
  assert.equal(p.evaluation.times.at(-1),2100000);
  assert.equal(p.validazioneCapienza.occupazioneSegmenti[1],0);
});
test('04 — missioni su nodo condiviso senza attesa',async()=>{
  const p=assemble(await diagnostic(fixture({shared:true})));
  assert.deepEqual(p.nodes,[1,2,3]);
  assert.deepEqual(p.evaluation.requests.map(r=>[r.start,r.end]),[[0,1],[1,2]]);
});
test('05 — stesso nodo con attesa: occorrenze distinte',async()=>{
  const p=assemble(await diagnostic(fixture({shared:true,waitMs:300000})));
  assert.deepEqual(p.evaluation.requests.map(r=>[r.start,r.end]),[[0,1],[3,4]]);
});
test('06 — economia del ciclo include il ritorno alla base',async()=>{
  const d=await diagnostic(fixture());
  assert.equal(d.ok,true,JSON.stringify(d));
  assert.equal(d.economia.economicamenteAttivabile,true);
  assert.ok(d.returnTrip.metres>0);
  assert.ok(d.economia.costoCompletoEuro>0);
  assemble(d);
});
test('07 — capienza insufficiente: rifiuto adapter',async()=>{
  const d=await diagnostic(fixture({second:false}),{vehicleOverride:{posti_totali:1}});
  assert.equal(d.ok,false);assert.equal(d.attivabile,false);
});
test('08 — richiesta PIXEL obsoleta: rifiuto',async()=>{
  const f=fixture({second:false});
  f.rm.set(11,{...f.rm.get(11),start_datetime:new Date(T+3600000).toISOString()});
  const d=await diagnostic(f);
  assert.equal(d.ok,false);assert.equal(d.motivo,'ORARIO_RICHIESTA_INCOERENTE');
});
test('09 — richiesta duplicata fra missioni: rifiuto',async()=>{
  const d=await diagnostic(fixture(),{requestIds:[[11],[11]]});
  assert.equal(d.ok,false);assert.equal(d.motivo,'RICHIESTA_DUPLICATA');
});
test('10 — trasferimento temporalmente impossibile: rifiuto',async()=>{
  const f=fixture({transferSeconds:300});
  f.road=async(a,b)=>Number(a.id)===2&&Number(b.id)===3?leg(900,1500):leg(120,1000);
  const d=await diagnostic(f);
  assert.equal(d.ok,false);assert.equal(d.motivo,'TRASFERIMENTO_TEMPORALMENTE_IMPOSSIBILE');
});
