// TURENTU — test deterministici del generatore multi-missione shadow.
// Salva in tests/test_pixel_multimission_shadow.mjs (rimuovi .txt).
// Esegui dalla root: node tests\test_pixel_multimission_shadow.mjs
import assert from 'node:assert/strict';
import { generaCicliDueMissioniShadow } from '../services/popbus/v2/pixel-multimission-shadow.js';

const T=Date.parse('2026-11-01T06:00:00Z');
const min=n=>T+n*60000;
const P=(lat,lon)=>({lat,lon});
const base=P(40,18), a0=P(40.1,18), a1=P(40.2,18), b0=P(40.3,18), b1=P(40.4,18);
const vehicles=[{id:361,lat:base.lat,lon:base.lon,euroKm:1,posti_totali:30}];
const A={pixelOpportunitaId:117,from:a0,to:a1,departure:min(120),arrival:min(180),kmMissione:30,peak:8,
  requests:[{id:101,prezzo:40},{id:201,prezzo:10}]};
const B={pixelOpportunitaId:118,from:b0,to:b1,departure:min(210),arrival:min(270),kmMissione:25,peak:8,
  requests:[{id:102,prezzo:40},{id:202,prezzo:10}]};
const route=(from,to)=>{
  if(from===undefined||to===undefined) throw Error('estremi assenti');
  const key=[from.lat,from.lon,to.lat,to.lon].join(',');
  const table=new Map([
    [[base.lat,base.lon,a0.lat,a0.lon].join(','),{metres:10000,seconds:900}],
    [[a1.lat,a1.lon,b0.lat,b0.lon].join(','),{metres:5000,seconds:600}],
    [[b1.lat,b1.lon,base.lat,base.lon].join(','),{metres:10000,seconds:900}]
  ]);
  if(!table.has(key)) throw Error('routing non previsto: '+key);
  return table.get(key);
};
const common={missions:[A,B],vehicles,movement:route,
  isAvailable:()=>true,hasConflicts:()=>false,now:min(0)};
let ok=0,failures=0;
async function test(name,fn){
  try{await fn();ok++;console.log('PASS',name);}
  catch(e){failures++;console.error('FAIL',name,e.stack);}
}
await test('01 ciclo A/R con richieste ordinarie: ricavi e ritorno unico',async()=>{
  const r=await generaCicliDueMissioniShadow(common);
  assert.equal(r.cicli.length,1);
  const c=r.cicli[0];
  assert.deepEqual(c.richieste,[101,201,102,202]);
  assert.deepEqual(c._pixelOpportunitaIds,[117,118]);
  assert.equal(c._shadow.economia.km.totali,80);
  assert.equal(c._shadow.economia.ricavoLordoEuro,100);
  assert.equal(c._shadow.economia.commissioneTurentuEuro,15);
  assert.equal(c._shadow.economia.margineEuro,5);
  assert.equal(c._shadow.waitingHours,20/60);
});
await test('02 compatibilita: trasferimento troppo lento',async()=>{
  const slow=(from,to)=>from===a1&&to===b0?{metres:5000,seconds:2400}:route(from,to);
  const r=await generaCicliDueMissioniShadow({...common,movement:slow});
  assert.equal(r.cicli.length,0);
});
await test('03 incompatibilita: richiesta duplicata',async()=>{
  const r=await generaCicliDueMissioniShadow({...common,missions:[A,{...B,requests:[{id:101,prezzo:40}]}]});
  assert.equal(r.cicli.length,0);
});
await test('04 capienza insufficiente',async()=>{
  const r=await generaCicliDueMissioniShadow({...common,vehicles:[{...vehicles[0],posti_totali:7}]});
  assert.equal(r.cicli.length,0);
});
await test('05 turno intero non disponibile',async()=>{
  const r=await generaCicliDueMissioniShadow({...common,isAvailable:()=>false});
  assert.equal(r.cicli.length,0);
});
await test('06 conflitto sul ciclo completo',async()=>{
  const r=await generaCicliDueMissioniShadow({...common,hasConflicts:()=>true});
  assert.equal(r.cicli.length,0);
});
await test('07 margine negativo conservato per ottimizzazione A/R globale',async()=>{
  const cheapA={...A,requests:[{id:101,prezzo:1}]};
  const cheapB={...B,requests:[{id:102,prezzo:1}]};
  const r=await generaCicliDueMissioniShadow({...common,missions:[cheapA,cheapB]});
  assert.equal(r.cicli.length,1);
  assert.ok(r.cicli[0].margine_ciclo_con_attesa_euro<0);
});
await test('08 limite coppie: fail-closed',async()=>{
  const C={...A,pixelOpportunitaId:119,requests:[{id:303,prezzo:5}]};
  await assert.rejects(
    generaCicliDueMissioniShadow({...common,missions:[A,B,C],maxPairs:1}),
    /limite coppie raggiunto/
  );
});
await test('09 routing mancante: errore esplicito',async()=>{
  await assert.rejects(
    generaCicliDueMissioniShadow({...common,movement:async()=>null}),
    /routing mancante/
  );
});
await test('10 attesa valorizzata nel costo',async()=>{
  const r=await generaCicliDueMissioniShadow({...common,costoAttesaOraEuro:6});
  assert.equal(r.cicli.length,1);
  assert.equal(r.cicli[0]._shadow.economia.costoAttesaEuro,2);
  assert.equal(r.cicli[0].margine_ciclo_con_attesa_euro,3);
});
console.log(`RISULTATO: ${ok}/10 superati, ${failures} falliti`);
if(failures)process.exitCode=1;
