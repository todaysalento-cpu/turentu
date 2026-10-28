// TURENTU — RED test del preflight puro del piano multimissione V1/V2.
// Copiare in tests/test_popbus_multimission_preflight_v2_red.js
// Non usa database, worker, socket o LIVE.
import assert from 'node:assert/strict';
import { validaPianoMultiMissione, validaOccupazioneMultiMissione } from '../services/popbus/v2/popbus-multimission-preflight.js';

const departure = Date.parse('2027-04-01T10:00:00Z');
const stops = {5:[40.121583,18.305914],6:[40.12584865,18.29992067],14:[40.121583,18.305914],15:[40.12584865,18.29992067]};
const mkLeg = (seconds,metres) => ({seconds,metres,polyline:'encoded-test-route'});
function fixture(v2=false) {
  const nodes=v2?[14,14,15,15,15,15,14,14]:[5,6,6,5];
  const secs=v2?[50,138,50,50,50,139,50]:[138,50,139];
  const metres=v2?[0,869,0,0,0,882,0]:[869,0,882];
  const legs=secs.map((s,i)=>mkLeg(s,metres[i]));
  const times=[0];for(const s of secs) times.push(times.at(-1)+s*1000);
  const ranges=v2?[[0,3],[4,7]]:[[0,1],[2,3]];
  return {
    tipoPiano:'CICLO_PIXEL_CORSA_UNICA_V1',
    ...(v2?{schemaVersion:2,tipoItinerario:'FERMATE_FISICHE'}:{}),
    veicoloId:70, nodes,legs,
    coordinates:nodes.map(id=>({id,lat:stops[id][0],lon:stops[id][1]})),
    busyStart:new Date(departure-60000).toISOString(),
    busyEnd:new Date(departure+times.at(-1)+60000).toISOString(),
    missioni:ranges.map(([startIndex,endIndex],i)=>({
      ordine:i+1,startIndex,endIndex,
      partenza:departure+times[startIndex],arrivo:departure+times[endIndex],
      ...(v2?{schemaVersion:2,tipoItinerario:'FERMATE_FISICHE',
        nodiTerritoriali:i===0?[5,6]:[6,5],pixelOpportunitaId:501+i,
        pixelDirettriceId:601+i,pixelVersione:3+i,corridoioPixelId:`pixel-engine-${i+1}`}:{})
    })),
    evaluation:{departure,arrival:departure+times.at(-1),times,
      requests:ranges.map(([startIndex,endIndex],i)=>({id:900001+i,start:startIndex,end:endIndex}))}
  };
}
let pass=0,fail=0;
function test(name,fn) {try{fn();pass++;console.log('PASS '+name);}catch(e){fail++;console.log('RED '+name+' — '+e.message);}}
function rejects(name,mutate){test(name,()=>{const p=fixture(true);mutate(p);assert.throws(()=>validaPianoMultiMissione(p,{veicoloId:70,postiTotali:4}));});}
test('V2 missione singola con due fermate accettata', () => {
  const p = fixture(true);

  p.nodes = [14, 15];
  p.coordinates = p.nodes.map(id => ({
    id,
    lat: stops[id][0],
    lon: stops[id][1]
  }));

  p.legs = [mkLeg(138, 869)];

  p.missioni = [{
    ordine: 1,
    startIndex: 0,
    endIndex: 1,
    partenza: departure,
    arrivo: departure + 138000,
    schemaVersion: 2,
    tipoItinerario: 'FERMATE_FISICHE',
    nodiTerritoriali: [5, 6],
    pixelOpportunitaId: 501,
    pixelDirettriceId: 601,
    pixelVersione: 3,
    corridoioPixelId: 'pixel-engine-1'
  }];

  p.evaluation = {
    departure,
    arrival: departure + 138000,
    times: [0, 138000],
    requests: [{ id: 900001, start: 0, end: 1 }]
  };

  p.busyEnd = new Date(departure + 198000).toISOString();

  const risultato = validaPianoMultiMissione(p, {
    veicoloId: 70,
    postiTotali: 4
  });

  assert.equal(risultato.numeroMissioni, 1);
  assert.equal(risultato.nodi, 2);

  const occupazione = validaOccupazioneMultiMissione(
    p,
    [{ id: 900001, posti_richiesti: 2 }],
    4
  );

  assert.equal(occupazione.peak, 2);
  assert.equal(occupazione.postiDisponibili, 2);
});

test('V1 con una sola missione respinta', () => {
  const p = fixture(false);
  p.missioni = [p.missioni[0]];
  p.evaluation.requests = [p.evaluation.requests[0]];

  assert.throws(
    () => validaPianoMultiMissione(p, {
      veicoloId: 70,
      postiTotali: 4
    }),
    /numero missioni/
  );
});
console.log('=== TURENTU — PREFLIGHT PURO MULTIMISSIONE V1/V2 RED ===');
test('V1 invariato',()=>{const p=fixture(false);const r=validaPianoMultiMissione(p,{veicoloId:70,postiTotali:4});assert.equal(r.numeroMissioni,2);});
test('V2 fisico/territoriale accettato',()=>{const p=fixture(true);const r=validaPianoMultiMissione(p,{veicoloId:70,postiTotali:4});assert.equal(r.numeroMissioni,2);});
test('occupazione V2 (2 posti, picco 1)',()=>{const p=fixture(true);const r=validaOccupazioneMultiMissione(p,[{id:900001,posti_richiesti:1},{id:900002,posti_richiesti:1}],4);assert.equal(r.peak,1);assert.equal(r.totalePasseggeri,2);});
rejects('V2 marker fisico assente',p=>{delete p.tipoItinerario;});
rejects('V2 metadati territoriali assenti',p=>{delete p.missioni[0].nodiTerritoriali;});
rejects('V2 ID fermata discordante dalle coordinate',p=>{p.coordinates[0].id=999;});
rejects('V2 tratte senza polilinea',p=>{p.legs[1].polyline='';});
rejects('V2 tempi non coerenti',p=>{p.evaluation.times[2]+=5000;});
rejects('V2 indice globale passeggero fuori missione',p=>{p.evaluation.requests[0].end=5;});
rejects('V2 missioni sovrapposte',p=>{p.missioni[1].startIndex=2;});
console.log(`\nRISULTATO: ${pass} PASS, ${fail} RED/FAIL. Database reale: 0 scritture; LIVE: NO.`);
if(fail)process.exitCode=1;
