// TURENTU P0-C8.19G — geometria assembler -> ricostruzione acceptance.
// TEST PURO: nessun DB, Stripe, API o scrittura. Polyline sintetiche coerenti
// con i nodi: NON sono percorsi stradali e NON autorizzano attivazioni.
// Copiare in tests/ eliminando .txt, poi: node tests/test_pixel_popbus_p0_c8_19g_geometria_acceptance.mjs
import assert from 'node:assert/strict';
import polyline from 'polyline';
import * as turf from '@turf/turf';
import { componiCicloInCorsa } from '../services/popbus/v2/popbus-single-corsa-assembler.js';

const PASS = s => console.log('PASS', s);
const nodes = [
  { id: 8, lat: 39.9302065, lon: 18.3584374 },
  { id: 5, lat: 40.117872, lon: 18.298862 },
  { id: 7, lat: 40.3522, lon: 18.1755 }
];
const lookup = new Map(nodes.map(n => [n.id, n]));
const xy = n => [n.lat, n.lon];
const round5 = n => Math.round(n * 1e5) / 1e5;
const samePoint = (a,b) => Array.isArray(a) && Array.isArray(b) &&
  Math.abs(a[0]-b[0]) <= 0.000011 && Math.abs(a[1]-b[1]) <= 0.000011;
const mkLeg = (from,to,metres,seconds) => ({
  metres, seconds, polyline: polyline.encode([xy(lookup.get(from)),xy(lookup.get(to))])
});
const d1 = Date.parse('2026-11-01T13:00:00Z');
const d2 = Date.parse('2026-11-01T15:15:00Z');
const dur = (1714+1901)*1000;
const mkReq = ids => ids.map((id,i) => ({ id, start:i===1?1:0, end:i===0?1:2, posti_richiesti:1 }));
const mission = (departure,ids) => ({
  nodes:[8,5,7],
  legs:[mkLeg(8,5,24459,1714),mkLeg(5,7,31364,1901)],
  departure, arrival:departure+dur, requests:mkReq(ids), corridorId:'territorial:8>5>7'
});
const transferSeconds=2856;
const waitMinutes=(d2-(d1+dur)-transferSeconds*1000)/60000;
assert.ok(waitMinutes>0);
const plan=componiCicloInCorsa({
  missioni:[mission(d1,[196,197,198]),mission(d2,[205,206,207])],
  trasferimenti:[{seconds:transferSeconds,attesaMinuti:waitMinutes,
    leg:mkLeg(7,8,53029,transferSeconds)}],
  nodi:nodes,veicoloId:353,postiTotali:10,
  busyStart:new Date(d1-3600000).toISOString(),
  busyEnd:new Date(d2+dur+3600000).toISOString(),
  approach:{metres:0,seconds:0},returnTrip:{metres:0,seconds:0}
});
assert.equal(plan.nodes.length,7);
assert.equal(plan.legs.length,6);
assert.equal(plan.missioni[1].startIndex,4);
PASS('Assembler: 2 missioni, 7 nodi, 6 tratte, indici globali coerenti');

// Riproduzione fedele della logica acceptance.js, righe 520-550.
function rebuild(legs) {
  const coords=[]; const indices=[0]; const offsets=[0];
  const decodedLegs=[];
  for (const l of legs) {
    const decoded=polyline.decode(l.polyline);
    if (decoded.length<2) throw Error('Geometria non valida');
    decodedLegs.push(decoded);
    coords.push(...(coords.length ? decoded.slice(1) : decoded));
    indices.push(coords.length-1);
    const metres=turf.length(turf.lineString(decoded.map(p=>[p[1],p[0]])),
      {units:'kilometers'})*1000;
    offsets.push(offsets.at(-1)+metres);
  }
  return {coords,indices,offsets,decodedLegs};
}
const geo=rebuild(plan.legs);
assert.equal(geo.indices.length,plan.nodes.length);
assert.equal(geo.offsets.length,plan.nodes.length);
assert.ok(geo.coords.length>=2);
PASS('Acceptance: decode, concatenazione, indici e offset completi');

for(let i=0;i<geo.decodedLegs.length;i++) {
  const pts=geo.decodedLegs[i];
  assert.ok(pts.length>=2,`Tratta ${i}: meno di 2 coordinate`);
  assert.ok(samePoint(pts[0],xy(plan.coordinates[i])),`Tratta ${i}: inizio non allineato al nodo`);
  assert.ok(samePoint(pts.at(-1),xy(plan.coordinates[i+1])),`Tratta ${i}: fine non allineata al nodo`);
  if(i>0) assert.ok(samePoint(geo.decodedLegs[i-1].at(-1),pts[0]),
    `Tratte ${i-1}/${i}: discontinuita geometrica`);
}
PASS('Continuita geometrica: ogni tratta parte e termina sui nodi globali');

const waitIndices=plan.legs.map((l,i)=>l.attesa?i:-1).filter(i=>i>=0);
assert.equal(waitIndices.length,1,'Attesa attesa una sola volta');
const wi=waitIndices[0];
assert.equal(plan.legs[wi].metres,0);
assert.ok(plan.legs[wi].seconds>0);
assert.equal(geo.decodedLegs[wi].length,2);
assert.ok(samePoint(geo.decodedLegs[wi][0],geo.decodedLegs[wi][1]));
assert.ok(Math.abs(geo.offsets[wi+1]-geo.offsets[wi])<0.000001);
assert.ok(geo.indices[wi+1]>geo.indices[wi]);
PASS('Attesa: due punti identici, tempo positivo, zero metri, indice avanzato');

for(const r of plan.evaluation.requests){
  assert.ok(Number.isInteger(r.start)&&Number.isInteger(r.end));
  assert.ok(r.start>=0&&r.end<plan.nodes.length&&r.end>r.start);
  assert.ok(geo.indices[r.end]>geo.indices[r.start],`Richiesta ${r.id}: indici polyline`);
  assert.ok(geo.offsets[r.end]>geo.offsets[r.start],`Richiesta ${r.id}: offset`);
}
PASS('Sei richieste: indici e offset di salita/discesa validi');

// Controllo NEGATIVO: la ricostruzione originale non verifica continuita.
// Il nostro controllo deve riconoscere una tratta valida ma geograficamente scollegata.
const broken=[...plan.legs];
broken[1]={...broken[1],polyline:polyline.encode([[41,19],[42,20]])};
const reconstructedBroken=rebuild(broken);
assert.equal(reconstructedBroken.indices.length,plan.nodes.length,
  'Il controllo originale dovrebbe ancora accettare la forma della geometria');
assert.equal(samePoint(reconstructedBroken.decodedLegs[0].at(-1),
  reconstructedBroken.decodedLegs[1][0]),false);
PASS('Negativo: una polyline scollegata passa i soli controlli strutturali acceptance');

const declared=plan.legs.reduce((s,l)=>s+Number(l.metres),0);
const geometric=geo.offsets.at(-1);
console.log('METRICHE: '+JSON.stringify({
  nodi:plan.nodes.length,tratte:plan.legs.length,
  attesaSecondi:plan.legs[wi].seconds,
  metriDichiarati:declared,metriGeometrici:Math.round(geometric),
  nota:'Routing sintetico rettilineo: la differenza non e una prova di errore economico'
}));
console.log('ESITO: TEST GEOMETRICO PURO COMPLETATO; nessuna attivazione o routing reale certificato.');
