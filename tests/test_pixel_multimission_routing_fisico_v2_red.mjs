// TURENTU - RED test del contratto routing fisico V2 (nessun DB, nessun LIVE).
// Copiare in tests/test_pixel_multimission_routing_fisico_v2_red.mjs
// Eseguire: node tests\test_pixel_multimission_routing_fisico_v2_red.mjs
import assert from 'node:assert/strict';
import polyline from 'polyline';
import { generaCicliDueMissioniShadow } from '../services/popbus/v2/pixel-multimission-shadow.js';

const T = Date.parse('2027-04-01T06:00:00Z');
const min = n => T + n * 60000;
const P = (lat, lon) => ({lat, lon});
const base=P(40,18), a0=P(40.01,18), a1=P(40.02,18), b0=P(40.03,18), b1=P(40.04,18);
const A={pixelOpportunitaId:117,from:a0,to:a1,departure:min(120),arrival:min(180),kmMissione:3,peak:1,requests:[{id:101,prezzo:50}]};
const B={pixelOpportunitaId:118,from:b0,to:b1,departure:min(210),arrival:min(270),kmMissione:3,peak:1,requests:[{id:102,prezzo:50}]};
const vehicle={id:361,...base,euroKm:1,posti_totali:4};
const route=(from,to)=>({metres:1200,seconds:600,polyline:polyline.encode([[from.lat,from.lon],[to.lat,to.lon]]),roadCoincident:false});
const common={missions:[A,B],vehicles:[vehicle],movement:route,isAvailable:async()=>true,hasConflicts:async()=>false,now:min(0),contrattoRoutingFisicoV2:true};
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('RED',name, e.message);}}

await test('V2 conserva geometrie di avvicinamento, trasferimento e ritorno',async()=>{
  const out=await generaCicliDueMissioniShadow(common);
  assert.equal(out.cicli.length,1);
  const s=out.cicli[0]._shadow;
  for(const k of ['approach','transfer','returnTrip']){
    assert.equal(typeof s[k].polyline,'string',`${k}: polyline assente`);
    assert.ok(polyline.decode(s[k].polyline).length>=2);
    assert.equal(s[k].roadCoincident,false);
  }
});
await test('V2 rifiuta routing senza polilinea',async()=>{
  await assert.rejects(generaCicliDueMissioniShadow({...common,movement:async()=>({metres:1200,seconds:600})}),/polyline|geometri|routing/i);
});
await test('V2 rifiuta geometria non ancorata agli estremi',async()=>{
  const wrong=polyline.encode([[41,19],[41.01,19.01]]);
  await assert.rejects(generaCicliDueMissioniShadow({...common,movement:async()=>({metres:1200,seconds:600,polyline:wrong,roadCoincident:false})}),/ancorat|estrem|geometri|routing/i);
});
await test('V2 preserva trasferimento coincidente con geometria valida',async()=>{
  const shared=P(a1.lat,a1.lon);
  const B2={...B,from:shared};
  const coincident=(from,to)=>{
    if(from.lat===to.lat&&from.lon===to.lon) return {metres:0,seconds:0,polyline:polyline.encode([[from.lat,from.lon],[to.lat,to.lon]]),roadCoincident:true};
    return route(from,to);
  };
  const out=await generaCicliDueMissioniShadow({...common,missions:[A,B2],movement:coincident});
  assert.equal(out.cicli.length,1);
  assert.equal(out.cicli[0]._shadow.transfer.metres,0);
  assert.equal(out.cicli[0]._shadow.transfer.seconds,0);
  assert.equal(out.cicli[0]._shadow.transfer.roadCoincident,true);
  assert.equal(polyline.decode(out.cicli[0]._shadow.transfer.polyline).length,2);
});
console.log(`CONTRATTO ROUTING FISICO V2 RED: ${passed} PASS, ${failed} RED`);
if(failed)process.exitCode=1;
