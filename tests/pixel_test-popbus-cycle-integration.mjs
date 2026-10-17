// TURENTU PIXEL -> POPBUS V2: collaudo isolato, senza DB o worker.
import assert from 'node:assert/strict';
import { diagnosticaCicloPixelPopbus } from '../services/pixel/pixel-popbus-cycle-adapter.js';

const t=Date.UTC(2027,3,1,8,0,0);
const nodes=[{id:6,lat:39.905,lon:18.364},{id:5,lat:40.118,lon:18.299},{id:7,lat:40.352,lon:18.176}];
const vehicle={id:101,driver_id:88,posti_totali:8,euro_km:0.5,lat:nodes[0].lat,lon:nodes[0].lon};
const req=(id,a,b,min,prezzo=60,posti=2)=>({id,start_node_id:a,end_node_id:b,
  start_datetime:new Date(t+min*60000).toISOString(),posti_richiesti:posti,prezzo,classe:'STANDARD'});
// Due richieste con origine e destinazione diverse sulla stessa missione.
const requests=[req(9001,6,7,0),req(9002,5,7,30),req(9003,7,5,90),req(9004,5,6,120)];
const leg={metres:20000,seconds:1800,polyline:'abc',roadCoincident:false};
const corridors={
  'px-out':{id:'px-out',nodes:[6,5,7],legs:[leg,leg],richiestaIds:[9001,9002]},
  'px-back':{id:'px-back',nodes:[7,5,6],legs:[leg,leg],richiestaIds:[9003,9004]}
};
const engine={getCorridor:id=>corridors[id]??null,getRequest:id=>requests.find(r=>r.id===id)??null};
const road=async(a,b)=>({metres:20000,seconds:1800});
const missioni=[{corridorId:'px-out',requestIds:[9001,9002]},
  {corridorId:'px-back',requestIds:[9003,9004]}];
const run=(extra={})=>diagnosticaCicloPixelPopbus({engine,missioni,richieste:requests,vehicle,nodes,road,
  now:t-3600000,maxWaitMin:90,...extra});
const result=await run();
assert.equal(result.ok,true,JSON.stringify(result));
assert.equal(result.attivabile,false);
assert.equal(result.missioni.length,2);
assert.equal(result.missioni[0].peak,4);
assert.equal(result.missioni[1].peak,2);
console.log('OK 1: richieste intermedie e occupazione per segmento preservate');
assert.equal(result.economia.km.missioni,80);
assert.equal(result.economia.km.ritornoBase,0);
assert.equal(result.economia.km.trasferimenti,0);
assert.equal(result.economia.km.avvicinamento,0);
assert.equal(result.economia.km.totali,80);
console.log('OK 2: andata e ritorno commerciale contati una sola volta');
assert.equal(result.economia.ricavoLordoEuro,240);
assert.equal(result.economia.commissioneTurentuEuro,36);
assert.equal(result.economia.costoCompletoEuro,40);
console.log('OK 3: commissione e costo ciclo netto corretti');
const cheap=await run({richieste:requests.map(r=>({...r,prezzo:1}))});
assert.equal(cheap.ok,false);
assert.equal(cheap.motivo,'ECONOMIA_NETTA_INSUFFICIENTE');
console.log('OK 4: ricavi insufficienti scartati');
const returnVehicle={...vehicle,lat:40.01,lon:18.36};
const returnCase=await run({vehicle:returnVehicle});
assert.equal(returnCase.ok,true,JSON.stringify(returnCase));
assert.equal(returnCase.economia.km.avvicinamento,20);
assert.equal(returnCase.economia.km.ritornoBase,20);
assert.equal(returnCase.economia.km.totali,120);
console.log('OK 5: avvicinamento e ritorno alla base non nulli conteggiati');
const capacity=await run({vehicle:{...vehicle,posti_totali:3}});
assert.equal(capacity.ok,false);
assert.equal(capacity.motivo,'COMPATIBILITA_NON_SUPERATA');
console.log('OK 6: capienza insufficiente bloccata');
const validated=await run({validateVehicle:async()=>true,validateCandidate:async()=>true});
assert.equal(validated.validazionePreliminare,true);
assert.equal(validated.attivabile,false);
console.log('OK 7: validatori non producono attivazioni');
const unavailable=await run({validateVehicle:async()=>false});
assert.equal(unavailable.motivo,'VEICOLO_NON_DISPONIBILE');
console.log('OK 8: veicolo indisponibile scartato');
const mismatch=await run({richieste:requests.map(r=>r.id===9002?{...r,start_datetime:new Date(t+31*60000).toISOString()}:r)});
assert.equal(mismatch.motivo,'ORARIO_RICHIESTA_INCOERENTE');
console.log('OK 9: snapshot orario incoerente scartato');
console.log('PIXEL POPBUS CICLO: 9 test superati; routing simulato; nessuna query DB');
