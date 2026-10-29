// TURENTU POPBUS V2 - RED: propagazione routing fisico nel selettore.
// Salvare come tests/test_popbus_physical_selector_routing_v2_red.mjs
// Nessun DB, nessun LIVE.
import assert from 'node:assert/strict';
import polyline from 'polyline';
import { selezionaCicliFisiciShadow } from '../services/popbus/v2/popbus-physical-cycle-selector.js';

const NOW = Date.parse('2027-04-01T07:00:00.000Z');
const BASE = {lat:40,lon:18};
const S1 = {id:101,lat:40.01,lon:18};
const S2 = {id:102,lat:40.02,lon:18};
const S3 = {id:103,lat:40.03,lon:18};
const S4 = {id:104,lat:40.04,lon:18};
const vehicle = {id:7,...BASE,euro_km:1,posti_totali:4};
const candidate = (id,from,to,departure,arrival) => ({
  tipoItinerario:'FERMATE_FISICHE',schemaVersion:2,
  vehicleId:7,pixelOpportunitaId:100+id,corridoioPixelId:'corridor-test',
  from:{lat:from.lat,lon:from.lon},to:{lat:to.lat,lon:to.lon},
  departure,arrival,kmMissione:3,peak:1,
  requests:[{id,prezzo:100}],nodiFisici:[from,to],
  plan:{nodes:[from.id,to.id],legs:[{metres:3000,seconds:1200,polyline:polyline.encode([[from.lat,from.lon],[to.lat,to.lon]])}]},
  evaluation:{requests:[{id,start:0,end:1,posti_richiesti:1}]}
});
const A = candidate(1,S1,S2,NOW+2*3600000,NOW+3*3600000);
const B = candidate(2,S3,S4,NOW+4*3600000,NOW+5*3600000);
const route = (from,to) => {
  const same = from.lat===to.lat && from.lon===to.lon;
  return {metres:same?0:1200,seconds:same?0:600,
    polyline:polyline.encode([[from.lat,from.lon],[to.lat,to.lon]]),roadCoincident:same};
};
async function select({candidati=[A],movement=route,validateSingle=async()=>true}={}) {
  return selezionaCicliFisiciShadow({
    candidati,vehicles:[vehicle],movement,
    isAvailable:async()=>true,hasConflicts:async()=>false,
    validateSingle,validatePair:async()=>true,
    now:NOW,maxPairs:100,maxRoutingCalls:30,maxRisultati:10,
    contrattoRoutingFisicoV2:true
  });
}
let passed=0,red=0;
async function test(name,fn) {
  try {await fn();passed++;console.log('PASS',name);}
  catch(e) {red++;console.error('RED',name,e.message);}
}
function checkLeg(leg,label) {
  assert.ok(leg,`${label}: segmento assente`);
  assert.equal(typeof leg.polyline,'string',`${label}: polyline assente`);
  assert.ok(polyline.decode(leg.polyline).length>=2,`${label}: polilinea incompleta`);
  assert.equal(typeof leg.roadCoincident,'boolean',`${label}: roadCoincident assente`);
}
await test('V2 singola: conserva avvicinamento e ritorno',async()=>{
  const out=await select();
  assert.equal(out.migliorCiclo.missioni.length,1);
  assert.deepEqual(out.migliorCiclo.baseOperativa,BASE);
  const r=out.migliorCiclo.routingFisico;
  assert.ok(r,'routingFisico assente');
  checkLeg(r.approach,'approach');
  checkLeg(r.returnTrip,'returnTrip');
  assert.equal(r.transfer??null,null);
  assert.equal(r.waitingHours,0);
});
await test('V2 coppia: conserva tre segmenti e attesa',async()=>{
  const out=await select({candidati:[A,B],validateSingle:null});
  assert.equal(out.migliorCiclo.missioni.length,2);
  assert.deepEqual(out.migliorCiclo.baseOperativa,BASE);
  const r=out.migliorCiclo.routingFisico;
  assert.ok(r,'routingFisico assente');
  for(const k of ['approach','transfer','returnTrip']) checkLeg(r[k],k);
  assert.ok(Number.isFinite(r.waitingHours) && r.waitingHours>=0,'waitingHours non valida');
});
await test('V2 rifiuta routing senza polilinea',async()=>{
  await assert.rejects(select({movement:async()=>({metres:1200,seconds:600})}),/polyline|geometri|routing/i);
});
await test('V2 coppia: trasferimento coincidente preservato',async()=>{
  const B2=candidate(2,S2,S4,NOW+4*3600000,NOW+5*3600000);
  const out=await select({candidati:[A,B2],validateSingle:null});
  const r=out.migliorCiclo.routingFisico;
  assert.ok(r,'routingFisico assente');
  checkLeg(r.transfer,'transfer');
  assert.equal(r.transfer.metres,0);
  assert.equal(r.transfer.seconds,0);
  assert.equal(r.transfer.roadCoincident,true);
});
console.log(`CONTRATTO SELECTOR ROUTING FISICO V2 RED: ${passed} PASS, ${red} RED`);
if(red)process.exitCode=1;
