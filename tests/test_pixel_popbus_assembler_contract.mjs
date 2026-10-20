import test from 'node:test';
import assert from 'node:assert/strict';
import { componiCicloInCorsa } from '../services/popbus/v2/popbus-single-corsa-assembler.js';

const T = Date.parse('2030-04-01T10:00:00Z');
const nodi = [
  {id:1,lat:40.1,lon:18.1},{id:2,lat:40.2,lon:18.2},
  {id:3,lat:40.3,lon:18.3},{id:4,lat:40.4,lon:18.4},
];
const leg = (seconds=600) => ({metres:3000,seconds,polyline:'_p~iF~ps|U_ulLnnqC_mqNvxq`@'});
const missione = (corridorId,nodes,departure,posti=2) => ({
  corridorId,nodes,legs:[leg()],departure,arrival:departure+600000,
  requests:[{id:corridorId,start:0,end:1,posti_richiesti:posti}]
});
const build = (missioni,trasferimenti=[]) => componiCicloInCorsa({
  missioni,trasferimenti,nodi,veicoloId:10,postiTotali:4,
  busyStart:new Date(T-600000).toISOString(),
  busyEnd:new Date(T+3600000).toISOString(),
  approach:leg(),returnTrip:leg()
});
const check = p => {
  assert.equal(p.attivabile,false);
  assert.equal(p.nodes.length,p.legs.length+1);
  assert.equal(p.evaluation.times.length,p.nodes.length);
  assert.equal(p.validazioneCapienza.verificata,true);
  for (const r of p.evaluation.requests) {
    assert.ok(r.start>=0 && r.end>r.start && r.end<p.nodes.length);
  }
};
test('una missione: corsa unica e occupazione',()=>{
  const p=build([missione(101,[1,2],T)]);check(p);
  assert.equal(p.missioni.length,1);
  assert.equal(p.evaluation.peak,2);
  assert.equal(p.evaluation.times.at(-1),600000);
});
test('due missioni consecutive su nodo condiviso',()=>{
  const p=build([missione(101,[1,2],T),missione(102,[2,3],T+600000)],
    [{seconds:0,metres:0,attesaMinuti:0,leg:{metres:0,seconds:0,roadCoincident:true}}]);
  check(p);assert.deepEqual(p.nodes,[1,2,3]);
  assert.deepEqual(p.evaluation.requests.map(r=>[r.start,r.end]),[[0,1],[1,2]]);
  assert.equal(p.evaluation.peak,2);
});
test('trasferimento stradale e attesa: indici e tempi globali',()=>{
  const p=build([missione(101,[1,2],T),missione(102,[3,4],T+1500000)],
    [{seconds:300,metres:1500,attesaMinuti:10,leg:leg(300)}]);
  check(p);assert.equal(p.evaluation.times.at(-1),2100000);
  assert.deepEqual(p.evaluation.requests.map(r=>[r.start,r.end]),[[0,1],[3,4]]);
  assert.equal(p.validazioneCapienza.occupazioneSegmenti[1],0);
});
test('stesso nodo con attesa: occorrenze distinte',()=>{
  const p=build([missione(101,[1,2],T),missione(102,[2,3],T+900000)],
    [{seconds:0,metres:0,attesaMinuti:5,leg:{metres:0,seconds:0,roadCoincident:true}}]);
  check(p);assert.deepEqual(p.evaluation.requests.map(r=>[r.start,r.end]),[[0,1],[3,4]]);
  assert.equal(p.evaluation.times.at(-1),1500000);
});
test('geometria stradale mancante: rifiuto fail-closed',()=>{
  const m=missione(101,[1,2],T);delete m.legs[0].polyline;
  assert.throws(()=>build([m]),/geometria verificata mancante/);
});
test('capienza segmento superata: rifiuto',()=>{
  assert.throws(()=>build([missione(101,[1,2],T,5)]),/Capienza superata/);
});
