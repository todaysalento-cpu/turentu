import assert from 'node:assert/strict';
import { generaSequenzeStradaliFermate } from './popbus-stop-sequencer.service.js';
const stop = (id, indice, lat) => ({ visita_id:id, fermata_id:id, indiceTerritoriale:indice,
  lat, lon:18, eventi:[{ richiesta_id:id, tipo:'salita', posti:1 }, { richiesta_id:id, tipo:'discesa', posti:1 }] });
// Eventi salita/discesa nella stessa visita sono intenzionalmente non validi:
// la verifica richiede discese di richieste già salite in visite precedenti.
const visite = [
  { ...stop(90,0,0), eventi:[{richiesta_id:1,tipo:'salita',posti:1}] },
  { ...stop(80,1,3), eventi:[{richiesta_id:2,tipo:'salita',posti:1}] },
  { ...stop(12,1,1), eventi:[{richiesta_id:1,tipo:'discesa',posti:1}] },
  { ...stop(45,1,2), eventi:[{richiesta_id:2,tipo:'discesa',posti:1}] }
];
const seq = { ok:true, visite, postiTotali:2 };
const routing = async (a,b) => ({ metres:Math.abs(a.lat-b.lat)*1000, seconds:Math.abs(a.lat-b.lat)*60, polyline:'fake' });
const r = await generaSequenzeStradaliFermate({sequenza:seq,routing,maxSequenze:10});
assert.equal(r.ok,true);
assert.equal(r.sequenze[0].sequenza.visite.map(x=>x.fermata_id).join(','),'90,12,80,45');
assert.equal(r.sequenze[0].metriStradali,4000);
assert.equal(r.sequenze[0].sequenza.peak,1);
assert.equal(r.sequenze.every(x=>x.sequenza.attivabile===false),true);
const limited = await generaSequenzeStradaliFermate({sequenza:seq,routing,maxPermutazioni:2});
assert.equal(limited.ok,false);
assert.equal(limited.motivo,'RICERCA_INCOMPLETA');
console.log('OK: ordine stradale, precedenze, capienza, SHADOW, budget');
