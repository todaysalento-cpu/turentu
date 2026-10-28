import assert from 'node:assert/strict';
import { costruisciSequenzaFermate } from '../services/popbus/v2/popbus-stop-itinerary.service.js';
import { generaSequenzeStradaliFermate } from '../services/popbus/v2/popbus-stop-sequencer.service.js';

const stop = (id, x) => ({fermata_id:id,lat:40+x/1000,lon:18,distanza_metri:100});
const assign = (id,start,end,up,down,posti=1) => ({richiesta_id:id,start_territoriale:start,end_territoriale:end,posti_richiesti:posti,salita:up,discesa:down});
const route = async (a,b) => ({metres:Math.round(Math.abs(a.lat-b.lat)*111000),seconds:Math.round(Math.abs(a.lat-b.lat)*7000)+1,polyline:'mock'});
const a = [
  assign(1,0,1,stop(90,0),stop(12,1)),
  assign(2,1,2,stop(80,3),stop(100,4))
];
const seq = costruisciSequenzaFermate({assegnazioni:a,postiTotali:1,verificaCapienza:false});
assert.equal(seq.capienzaVerificata,false);
const result = await generaSequenzeStradaliFermate({sequenza:seq,routing:route,maxSequenze:10});
assert.equal(result.ok,true);
assert.ok(result.sequenze.length>0);
assert.equal(result.sequenze[0].sequenza.visite.map(v=>v.fermata_id).join(','),'90,12,80,100');
assert.equal(result.sequenze[0].sequenza.peak,1);
assert.equal(result.attivabile,false);
console.log('PASS: sequenza valida, capienza verificata dopo riordino, attivabile:false');
const bad=costruisciSequenzaFermate({assegnazioni:[assign(1,0,2,stop(1,0),stop(3,2)),assign(2,1,3,stop(2,1),stop(4,3))],postiTotali:1,verificaCapienza:false});
const r2=await generaSequenzeStradaliFermate({sequenza:bad,routing:route});
assert.equal(r2.sequenze.length,0);
console.log('PASS: sovraccapienza obbligata scartata');
const budget=await generaSequenzeStradaliFermate({sequenza:seq,routing:route,maxPermutazioni:1});
assert.equal(budget.ok,false);
assert.equal(budget.motivo,'RICERCA_INCOMPLETA');
console.log('PASS: budget insufficiente = RICERCA_INCOMPLETA');
