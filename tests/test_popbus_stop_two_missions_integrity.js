import assert from 'node:assert/strict';
import { generaCicliDueMissioniShadow } from '../services/popbus/v2/pixel-multimission-shadow.js';
import { adattaMissioneFermate } from '../services/popbus/v2/popbus-stop-mission-adapter.service.js';
import { componiCicloInCorsa } from '../services/popbus/v2/popbus-single-corsa-assembler.js';
import { valutaEconomiaCicloFermate } from '../services/popbus/v2/popbus-stop-cycle-economics-adapter.service.js';

const BASE = Date.parse('2026-11-01T10:00:00+01:00');
const MIN = 60_000;
const clone = x => structuredClone(x);
const f14 = { fermata_id:14, nome:'Maglie - Piazzale Megapark', lat:40.121583, lon:18.305914 };
const f15 = { fermata_id:15, nome:'Maglie - Stazione ferroviaria', lat:40.1258486502909, lon:18.299920672780097 };
const veicolo = { id:900001, lat:40.11, lon:18.31, euroKm:1.50, posti_totali:4 };
const richieste = [
  { id:900001, posti_richiesti:2, prezzo:11 },
  { id:900002, posti_richiesti:2, prezzo:11 }
];
function alternativa(from,to,departure,metres,seconds,id) {
  const arrivo = departure + (50 + seconds)*1000;
  return {
    sequenza:{ok:true}, temporale:{ok:true}, qualita:{ok:true},
    itinerario:{
      ok:true, routingVerificato:true, departure, fineOperazioni:arrivo+50_000,
      visite:[
        {...from,arrivo:departure,partenza:departure+50_000,sostaSecondi:50,
          eventi:[{richiesta_id:id,tipo:'salita',posti:2,timestampOperazione:departure}]},
        {...to,arrivo,partenza:arrivo+50_000,sostaSecondi:50,
          eventi:[{richiesta_id:id,tipo:'discesa',posti:2,timestampOperazione:arrivo}]}
      ],
      legs:[{metres,seconds,polyline:`fixture-${from.fermata_id}-${to.fermata_id}`}]
    }
  };
}
const alternative = [
  alternativa(f14,f15,BASE,869,138,900001),
  alternativa(f15,f14,BASE+15*MIN,882,139,900002)
];
const adattate = alternative.map((alt,i)=>adattaMissioneFermate({
  alternativa:alt,richieste:[richieste[i]],corridorId:500001+i
}));
const missioni = adattate.map(a=>a.missione);
const nodi = [...new Map(adattate.flatMap(a=>a.nodi).map(n=>[Number(n.id),n])).values()];
const candidate = missioni.map((m,i)=>({
  pixelOpportunitaId:500001+i,
  from:{lat:alternative[i].itinerario.visite[0].lat,lon:alternative[i].itinerario.visite[0].lon},
  to:{lat:alternative[i].itinerario.visite[1].lat,lon:alternative[i].itinerario.visite[1].lon},
  departure:m.departure,arrival:m.arrival,
  kmMissione:m.legs.reduce((s,l)=>s+Number(l.metres),0)/1000,
  requests:[{id:richieste[i].id,prezzo:richieste[i].prezzo}],peak:2
}));
const same=(a,b)=>Number(a.lat)===Number(b.lat)&&Number(a.lon)===Number(b.lon);
const movement=async(a,b)=>same(a,b)?{metres:0,seconds:0}:{metres:5000,seconds:600};
const shadowArgs={
  missions:candidate,vehicles:[veicolo],movement,
  isAvailable:async()=>true,hasConflicts:async()=>false,
  now:BASE-60*MIN,maxPairs:10,maxRoutingCalls:10,costoAttesaOraEuro:0
};
const shadow=await generaCicliDueMissioniShadow(shadowArgs);
assert.equal(shadow.cicli.length,1,'baseline SHADOW');
const selected=shadow.cicli[0];
const transfer={...selected._shadow.transfer,routingVerificato:true};
const approach={...selected._shadow.approach,routingVerificato:true};
const returnTrip={...selected._shadow.returnTrip,routingVerificato:true};
const waitMinutes=(candidate[1].departure-candidate[0].arrival)/MIN;
const compose=(overrides={})=>componiCicloInCorsa({
  missioni,trasferimenti:[{...transfer,attesaMinuti:waitMinutes}],nodi,
  veicoloId:veicolo.id,busyStart:selected.partenza_base,
  busyEnd:selected.ritorno_base,approach,returnTrip,postiTotali:veicolo.posti_totali,
  ...overrides
});
const ciclo=compose();
const economicArgs={
  ciclo,missioni:alternative,missioniAdattate:missioni,
  trasferimenti:[transfer],richieste,avvicinamento:approach,
  ritornoBase:returnTrip,euroKm:veicolo.euroKm,
  oreAttesa:selected._shadow.waitingHours,costoAttesaOraEuro:0,
  altriCostiEuro:0,margineMinimoEuro:0
};
const economic=(overrides={})=>valutaEconomiaCicloFermate({...economicArgs,...overrides});
assert.equal(economic().economicamenteAttivabile,true,'baseline economia');

let passed=0;
async function check(name,fn) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch(err) { console.error(`FAIL ${name}: ${err.stack||err}`); process.exitCode=1; }
}
const throws=fn=>assert.throws(fn);

console.log('=== POPBUS V2 - INTEGRITY NEGATIVE TESTS (PURE / NO DB) ===');

await check('T1 - missione 2 anticipata: nessuna coppia SHADOW',async()=>{
  const altered=clone(candidate);
  altered[1].departure=candidate[0].arrival-60_000;
  altered[1].arrival=altered[1].departure+(candidate[1].arrival-candidate[1].departure);
  const result=await generaCicliDueMissioniShadow({...shadowArgs,missions:altered});
  assert.equal(result.cicli.length,0);
});
await check('T2 - capienza insufficiente: assemblatore rifiuta',()=>{
  throws(()=>compose({postiTotali:1}));
});
await check('T3 - ID richiesta duplicato: assemblatore rifiuta',()=>{
  const altered=clone(missioni);
  altered[1].requests[0].id=altered[0].requests[0].id;
  throws(()=>compose({missioni:altered}));
});
await check('T4 - chilometri assemblati manomessi: economia rifiuta',()=>{
  const altered=clone(ciclo);
  const i=altered.missioni[0].startIndex;
  altered.legs[i].metres+=100;
  throws(()=>economic({ciclo:altered}));
});
await check('T5 - durata segmento manomessa: economia rifiuta',()=>{
  const altered=clone(ciclo);
  altered.legs[0].seconds+=10;
  throws(()=>economic({ciclo:altered}));
});
await check('T6 - ricavi insufficienti: soglia economica non raggiunta',()=>{
  const altered=richieste.map(r=>({...r,prezzo:9}));
  const result=economic({richieste:altered});
  assert.equal(result.ok,true);
  assert.equal(result.economicamenteAttivabile,false);
  assert.equal(result.attivabile,false);
});
await check('T7 - routing trasferimento non verificato: economia rifiuta',()=>{
  const altered={...transfer,routingVerificato:false};
  throws(()=>economic({trasferimenti:[altered]}));
});
await check('T8 - richiesta attribuita alla missione errata: economia rifiuta',()=>{
  const altered=clone(ciclo);
  altered.missioni[0].richieste=[900002];
  throws(()=>economic({ciclo:altered}));
});
await check('T9 - missione originale non validata: economia rifiuta',()=>{
  const altered=clone(alternative);
  altered[1].qualita.ok=false;
  throws(()=>economic({missioni:altered}));
});
await check('T10 - costo trasferimento manomesso: economia rifiuta',()=>{
  const altered={...transfer,metres:123};
  throws(()=>economic({trasferimenti:[altered]}));
});
console.log(`\nRISULTATO: ${passed}/10 test negativi superati`);
if(passed!==10) process.exitCode=1;
