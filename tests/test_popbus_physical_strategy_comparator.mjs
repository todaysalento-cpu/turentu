// Test sintetico senza DB: eseguire dalla root del progetto.
import assert from 'node:assert/strict';
import { confrontaStrategieFisicheShadow } from '../services/popbus/v2/popbus-physical-strategy-comparator.js';
const stop=(id,lat,lon)=>({id,lat,lon});
const s1=stop(1,40,18),s2=stop(2,40.1,18),s3=stop(3,40.2,18);
const candidate=(vehicleId,op,id,from,to,departure,arrival,price)=>({
  tipoItinerario:'FERMATE_FISICHE',schemaVersion:2,vehicleId,pixelOpportunitaId:op,
  from,to,departure,arrival,kmMissione:10,peak:1,
  requests:[{id,prezzo:price}],plan:{nodes:[from.id,to.id],legs:[{metres:10000,seconds:600}]},
  nodiFisici:[from,to],evaluation:{requests:[{id,start:0,end:1}]}
});
const now=1_000_000;
const a=candidate(1,118,196,s1,s2,now+3600000,now+4200000,40);
const b=candidate(2,119,202,s2,s3,now+5400000,now+6000000,40);
const vehicles=[{id:1,lat:40,lon:18,euro_km:0.6,posti_totali:4},
  {id:2,lat:40.2,lon:18,euro_km:0.6,posti_totali:4}];
const mockCycle={shadow:true,attivabile:false,dbWrites:0,
  diagnostica:{completo:true},miglioriCicli:[]};
const args={candidati:[a,b],vehicles,now,movement:async()=>({metres:2000,seconds:200}),
  isAvailable:async()=>true,hasConflicts:async()=>false,
  validateSelection:async()=>true,selezioneFisica:mockCycle};
const result=await confrontaStrategieFisicheShadow(args);
assert.equal(result.shadow,true);
assert.equal(result.dbWrites,0);
assert.equal(result.offerte,0);
assert.equal(result.attivabile,false);
assert.equal(result.miglioreSingola.numeroRichieste,1);
assert.equal(result.miglioreCoppiaIndipendente.numeroRichieste,2);
assert.equal(result.miglioreTraStrategieEsaminate.numeroRichieste,2);
const linked=await confrontaStrategieFisicheShadow({...args,
  validateSelection:async requestIds=>requestIds.length===2});
assert.equal(linked.miglioreSingola,null);
assert.equal(linked.miglioreCoppiaIndipendente.numeroRichieste,2);
const rejected=await confrontaStrategieFisicheShadow({...args,
  validateSelection:async()=>false});
assert.equal(rejected.miglioreTraStrategieEsaminate,null);
console.log('POPBUS_STRATEGY_COMPARATOR_SHADOW_OK');
console.log(JSON.stringify(result,null,2));
