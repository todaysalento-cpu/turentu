// TURENTU - PIXEL -> POPBUS V2: due missioni fisiche, ciclo ed economia SHADOW.
// Servizi reali; simulati solo fermate, routing e disponibilita veicolo.
// Nessuna connessione DB, nessuna persistenza, nessuna attivazione LIVE.
import assert from 'node:assert/strict';
import polyline from '@mapbox/polyline';
import { generaAlternativeFisichePixelShadow } from '../services/popbus/v2/popbus-pixel-stop-bridge.service.js';
import { generaCicliDueMissioniShadow } from '../services/popbus/v2/pixel-multimission-shadow.js';
import { componiCicloInCorsa } from '../services/popbus/v2/popbus-single-corsa-assembler.js';
import { valutaEconomiaCicloFermate } from '../services/popbus/v2/popbus-stop-cycle-economics-adapter.service.js';

const BASE = Date.parse('2026-11-01T10:00:00+01:00');
const MIN = 60000;
const f14 = {fermata_id:14,nome:'Maglie - Piazzale Megapark',lat:40.121583,lon:18.305914,distanza_metri:50,nodo_territoriale_id:5,tipi_veicolo_ammessi:['autobus'],verificata:false};
const f15 = {fermata_id:15,nome:'Maglie - Stazione',lat:40.1258486502909,lon:18.299920672780097,distanza_metri:80,nodo_territoriale_id:6,tipi_veicolo_ammessi:['autobus'],verificata:false};
const veicolo = {id:900001,lat:40.11,lon:18.31,euroKm:1.50,posti_totali:4};
const richieste = [
  {id:900001,posti_richiesti:2,prezzo:11,start_datetime:new Date(BASE).toISOString()},
  {id:900002,posti_richiesti:2,prezzo:11,start_datetime:new Date(BASE+15*MIN).toISOString()}
];
const formazioni = [
  {pixelOpportunitaId:500001,pixelDirettriceId:400001,pixelVersione:3,nodiTerritoriali:[5,6],corridoioPixelId:'territorial:5>6',departure:BASE,evaluation:{requests:[{id:900001,start:0,end:1,posti_richiesti:2}]}},
  {pixelOpportunitaId:500002,pixelDirettriceId:400002,pixelVersione:3,nodiTerritoriali:[6,5],corridoioPixelId:'territorial:6>5',departure:BASE+15*MIN,evaluation:{requests:[{id:900002,start:0,end:1,posti_richiesti:2}]}}
];
let dbQueries=0;
let roadCalls=0;
const client={query:async()=>{dbQueries++;throw Error('QUERY_DB_VIETATA');}};
const road=async(a,b)=>{
  roadCalls++;
  const key=`${a.fermata_id}:${b.fermata_id}`;
  if(key==='14:15') return {metres:869,seconds:138,polyline:polyline.encode([[f14.lat,f14.lon],[f15.lat,f15.lon]])};
  if(key==='15:14') return {metres:882,seconds:139,polyline:polyline.encode([[f15.lat,f15.lon],[f14.lat,f14.lon]])};
  throw Error(`ROUTING_FERMATE_NON_PREVISTO:${key}`);
};
const servizi={cercaFermateCandidate:async({richiestaIds})=>richiestaIds.map(id=>({
  richiesta_id:id,
  salita:[id===900001?f14:f15],
  discesa:[id===900001?f15:f14],
  completa:true
}))};
const risultati=[];
for(let i=0;i<2;i++){
  const result=await generaAlternativeFisichePixelShadow({
    client,formazione:formazioni[i],richieste:[richieste[i]],postiTotali:veicolo.posti_totali,
    tipoVeicolo:'ncc',routing:road,servizi,maxCombinazioni:10,maxValutazioni:10
  });
  assert.equal(result.ok,true,JSON.stringify(result.diagnostica));
  assert.equal(result.alternativeFisiche.length,1,JSON.stringify(result.diagnostica));
  risultati.push(result);
}
const fisiche=risultati.map(r=>r.alternativeFisiche[0]);
const missioni=fisiche.map(a=>a.missione);
const nodi=[...new Map(fisiche.flatMap(a=>a.nodiFisici).map(n=>[Number(n.id),n])).values()];
const candidate=missioni.map((m,i)=>({
  pixelOpportunitaId:risultati[i].pixelOpportunitaId,
  from:{lat:nodi.find(n=>n.id===m.nodes[0]).lat,lon:nodi.find(n=>n.id===m.nodes[0]).lon},
  to:{lat:nodi.find(n=>n.id===m.nodes.at(-1)).lat,lon:nodi.find(n=>n.id===m.nodes.at(-1)).lon},
  departure:m.departure,arrival:m.arrival,
  kmMissione:m.legs.reduce((s,l)=>s+Number(l.metres),0)/1000,
  requests:[{id:richieste[i].id,prezzo:richieste[i].prezzo}],peak:2
}));
const same=(a,b)=>Number(a.lat)===Number(b.lat)&&Number(a.lon)===Number(b.lon);
const movement=async(a,b)=>same(a,b)?{metres:0,seconds:0}:{metres:5000,seconds:600};
const shadow=await generaCicliDueMissioniShadow({
  missions:candidate,vehicles:[veicolo],movement,
  isAvailable:async()=>true,hasConflicts:async()=>false,
  now:BASE-60*MIN,maxPairs:10,maxRoutingCalls:10,costoAttesaOraEuro:0
});
assert.equal(shadow.cicli.length,1,'atteso un ciclo multimissione shadow');
const selected=shadow.cicli[0];
const transfer={...selected._shadow.transfer,routingVerificato:true};
const approach={...selected._shadow.approach,routingVerificato:true};
const returnTrip={...selected._shadow.returnTrip,routingVerificato:true};
const waitMinutes=(missioni[1].departure-missioni[0].arrival)/MIN;
const ciclo=componiCicloInCorsa({
  missioni,trasferimenti:[{...transfer,attesaMinuti:waitMinutes}],nodi,
  veicoloId:veicolo.id,busyStart:selected.partenza_base,busyEnd:selected.ritorno_base,
  approach,returnTrip,postiTotali:veicolo.posti_totali
});
const economia=valutaEconomiaCicloFermate({
  ciclo,missioni:fisiche.map(x=>x.alternativa),missioniAdattate:missioni,
  trasferimenti:[transfer],richieste,avvicinamento:approach,ritornoBase:returnTrip,
  euroKm:veicolo.euroKm,oreAttesa:selected._shadow.waitingHours,
  costoAttesaOraEuro:0,altriCostiEuro:0,margineMinimoEuro:0
});
let passed=0;
const check=(name,fn)=>{try{fn();console.log('PASS - '+name);passed++;}catch(e){console.error('FAIL - '+name+': '+e.stack);process.exitCode=1;}};
console.log('=== PIXEL -> POPBUS V2: CICLO DUE MISSIONI FISICHE SHADOW ===');
check('due formazioni PIXEL e due missioni fisiche',()=>{
  assert.deepEqual(risultati.map(x=>x.pixelOpportunitaId),[500001,500002]);
  assert.deepEqual(risultati.map(x=>x.nodiTerritoriali),[[5,6],[6,5]]);
  assert.deepEqual(missioni.map(m=>m.nodes),[[14,14,15,15],[15,15,14,14]]);
});
check('routing, soste e cronologia fisica',()=>{
  assert.deepEqual(fisiche.map(a=>a.alternativa.kmMissione),[0.869,0.882]);
  assert.deepEqual(fisiche.map(a=>a.alternativa.itinerario.secondiSosta),[100,100]);
  assert.ok(missioni[0].arrival<missioni[1].departure);
  assert.ok(roadCalls>=2);
});
check('salite effettive e compatibilita temporale',()=>{
  for(let i=0;i<2;i++){
    const t=fisiche[i].alternativa.temporale.dettagli[0];
    assert.equal(t.fermataId,i===0?14:15);
    assert.equal(t.effettivo,formazioni[i].departure);
    assert.equal(t.compatibile,true);
  }
});
check('ciclo assemblato con richieste e capienza',()=>{
  assert.equal(ciclo.validazioneCapienza.verificata,true);
  assert.equal(ciclo.missioni.length,2);
  assert.deepEqual(new Set(ciclo.evaluation.requests.map(r=>Number(r.id))),new Set([900001,900002]));
});
check('economia intero ciclo e ritorno base',()=>{
  assert.equal(economia.ok,true);
  assert.equal(economia.economicamenteAttivabile,true);
  assert.equal(economia.attivabile,false);
  assert.equal(economia.dettaglioMissioni.length,2);
  assert.ok(economia.economia.km.totali>1.751);
});
check('nessun filtro veicolo, nessuna query DB, nessun LIVE',()=>{
  assert.equal(dbQueries,0);
  assert.ok(risultati.every(r=>r.attivabile===false));
  assert.ok(fisiche.every(a=>a.attivabile===false));
});
console.log(`RISULTATO: ${passed}/6 PASS; DB ${dbQueries} query; LIVE NO; routing deterministico.`);
if(passed!==6)process.exitCode=1;
