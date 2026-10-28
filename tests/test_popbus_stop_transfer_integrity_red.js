// POPBUS V2 - RED: integrita' trasferimenti fisici. Solo memoria, NO DB, NO LIVE.
import assert from 'node:assert/strict';
import polyline from '@mapbox/polyline';
import { componiCicloInCorsa } from '../services/popbus/v2/popbus-single-corsa-assembler.js';
import { valutaEconomiaCicloFermate } from '../services/popbus/v2/popbus-stop-cycle-economics-adapter.service.js';

const start = Date.parse('2027-04-01T08:00:00Z');
const points = [
  { id: 101, lat: 40.10, lon: 18.10 },
  { id: 102, lat: 40.11, lon: 18.11 },
  { id: 201, lat: 40.12, lon: 18.12 },
  { id: 202, lat: 40.13, lon: 18.13 }
];
const line = (a,b) => polyline.encode([[a.lat,a.lon],[b.lat,b.lon]]);
const road1 = { metres: 2000, seconds: 120, polyline: line(points[0],points[1]) };
const road2 = { metres: 2000, seconds: 120, polyline: line(points[2],points[3]) };
const transferLeg = { metres: 4000, seconds: 300, polyline: line(points[1],points[2]) };
const m1 = { nodes:[101,102], legs:[road1], requests:[{id:1,start:0,end:1,posti_richiesti:1}], departure:start, arrival:start+120000 };
const m2 = { nodes:[201,202], legs:[road2], requests:[{id:2,start:0,end:1,posti_richiesti:1}], departure:start+600000, arrival:start+720000 };
const baseTransfer = { seconds:300, metres:4000, leg:transferLeg, attesaMinuti:3 };
const assemble = (tr=baseTransfer, missions=[m1,m2], catalog=points) => componiCicloInCorsa({
  missioni:missions, trasferimenti:[tr], nodi:catalog, veicoloId:9,
  busyStart:new Date(start-600000).toISOString(), busyEnd:new Date(start+1500000).toISOString(),
  approach:{metres:1000}, returnTrip:{metres:1000}, postiTotali:4,
  contrattoTrasferimentiFisiciV2:true
});
const baseline = assemble();
assert.equal(baseline.missioni.length,2);
assert.equal(baseline.validazioneCapienza.verificata,true);
assert.equal(baseline.legs[1].polyline,transferLeg.polyline);
assert.equal(baseline.legs[2].attesa,true);
console.log('PASS: trasferimento stradale valido e attesa separata');

let pass=1, red=0;
function expectRejected(name, fn) {
  try { fn(); console.error('RED: '+name+' ACCETTATO'); red++; }
  catch(e) { console.log('PASS: '+name+' rifiutato: '+e.message); pass++; }
}
expectRejected('seconds dichiarati diversi da leg.seconds',()=>assemble({...baseTransfer,seconds:299}));
expectRejected('metres dichiarati diversi da leg.metres',()=>assemble({...baseTransfer,metres:3999}));
expectRejected('polilinea malformata',()=>assemble({...baseTransfer,leg:{...transferLeg,polyline:'!'}}));
expectRejected('polilinea non ancorata alle fermate',()=>assemble({...baseTransfer,leg:{...transferLeg,polyline:line(points[0],points[3])}}));

// Il ciclo gia' assemblato deve essere fedele al trasferimento originale.
const economic = (originalTransfer) => valutaEconomiaCicloFermate({
  ciclo:baseline,
  missioni:[
    {sequenza:{ok:true},temporale:{ok:true},qualita:{ok:true},itinerario:{ok:true,routingVerificato:true,legs:[road1]}},
    {sequenza:{ok:true},temporale:{ok:true},qualita:{ok:true},itinerario:{ok:true,routingVerificato:true,legs:[road2]}}
  ],
  missioniAdattate:[m1,m2],
  trasferimenti:[originalTransfer],
  richieste:[{id:1,prezzo:20},{id:2,prezzo:20}],
  avvicinamento:{metres:1000,routingVerificato:true},
  ritornoBase:{metres:1000,routingVerificato:true},
  euroKm:1
});
assert.equal(economic({...transferLeg,routingVerificato:true}).ok,true);
console.log('PASS: adapter economico con trasferimento valido'); pass++;
expectRejected('economia: durata originale differente',()=>economic({...transferLeg,seconds:299,routingVerificato:true}));
expectRejected('economia: polilinea originale differente',()=>economic({...transferLeg,polyline:line(points[0],points[3]),routingVerificato:true}));

// Fermate coincidenti: trasferimento nullo e attesa rimangono legittimi.
const sameStart = {...m2,nodes:[102,202]};
const coincident = assemble({seconds:0,metres:0,attesaMinuti:8},[m1,sameStart],points);
assert.equal(coincident.missioni.length,2);
console.log('PASS: trasferimento coincidente con attesa'); pass++;
console.log(`RISULTATO: ${pass} PASS, ${red} RED`);
console.log('DB: nessuna query; LIVE: NO');
// In fase RED non fallisce il processo per i rifiuti mancanti: li segnala esplicitamente.
