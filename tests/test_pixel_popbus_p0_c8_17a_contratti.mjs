// TURENTU P0-C8.17A — test puro, nessuna connessione DB/Stripe.
import assert from 'node:assert/strict';
import { componiCicloInCorsa } from '../services/popbus/v2/popbus-single-corsa-assembler.js';
import { validaPianoMultiMissione, validaOccupazioneMultiMissione } from '../services/popbus/v2/popbus-multimission-preflight.js';
import { preparaCicloPixelPerPersistenza } from '../services/popbus/v2/popbus-p0-c8-adapter.js';

const pass = x => console.log('PASS', x);
const t = s => Date.parse(s);
const nodes = [
  { id:8, lat:39.9302065, lon:18.3584374 },
  { id:5, lat:40.117872, lon:18.298862 },
  { id:7, lat:40.3522, lon:18.1755 }
];
// Polilinee segnaposto valide solo come stringhe per i controlli PURI.
// NON rappresentano un routing stradale verificato e NON vanno persistite.
const leg = (metres,seconds) => ({ metres,seconds,polyline:'_p~iF~ps|U_ulLnnqC_mqNvxq`@' });
const route = [leg(24459,1714),leg(31364,1901)];
const d1 = t('2026-11-01T13:00:00Z');
const d2 = t('2026-11-01T15:15:00Z');
const duration = 3615*1000;
const ids1 = [196,197,198], ids2 = [205,206,207];
const req = ids => ids.map((id,i)=>({id,start:i===1?1:0,end:i===0?1:2,posti_richiesti:1}));
const missions = [
 {nodes:[8,5,7],legs:route,departure:d1,arrival:d1+duration,requests:req(ids1),corridorId:'territorial:8>5>7'},
 {nodes:[8,5,7],legs:route,departure:d2,arrival:d2+duration,requests:req(ids2),corridorId:'territorial:8>5>7'}
];
const transferSecs=2856;
const waitMins=(d2-(d1+duration)-transferSecs*1000)/60000;
assert.equal(waitMins,27.15);
const plan=componiCicloInCorsa({
 missioni:missions,trasferimenti:[{...leg(53029,transferSecs),attesaMinuti:waitMins}],
 nodi:nodes,veicoloId:353,postiTotali:10,
 busyStart:new Date(d1-3600000).toISOString(),busyEnd:new Date(d2+duration+3600000).toISOString(),
 approach:{metres:0,seconds:0},returnTrip:{metres:0,seconds:0}
});
assert.equal(plan.tipoPiano,'CICLO_PIXEL_CORSA_UNICA_V1');
assert.equal(plan.missioni.length,2);
assert.equal(plan.nodes.length,7); // 3 nodi missione 1 + trasferimento + attesa + 2 nuovi nodi missione 2
assert.equal(plan.legs.length,6);
assert.equal(plan.missioni[0].startIndex,0);
assert.equal(plan.missioni[1].startIndex,4);
assert.equal(plan.evaluation.peak,2);
assert.equal(plan.validazioneCapienza.totalePasseggeri,6);
pass('Assembler reale: 2 missioni, trasferimento, attesa, 7 nodi e picco 2');
const check=validaPianoMultiMissione(plan,{veicoloId:353,postiTotali:10});
assert.equal(check.numeroMissioni,2);
pass('Preflight globale accetta il piano prodotto dall’assembler');
const dates = new Map([
 [196,d1],[197,d1+1714000],[198,d1],
 [205,d2],[206,d2+1714000],[207,d2]
]);
const rows=[...ids1,...ids2].map(id=>({id,stato:'in_lavorazione',corsa_id:null,cliente_id:4,
 posti_richiesti:1,prezzo:id===197||id===206?9:id===198||id===207?14:7,
 start_datetime:new Date(dates.get(id)).toISOString()}));
const occupancy=validaOccupazioneMultiMissione(plan,rows,10);
assert.equal(occupancy.peak,2);
assert.equal(occupancy.totalePasseggeri,6);
pass('Capienza DB simulata: 6 trasportati, picco 2, posti liberi 8');
const options={plan,richiesteBloccate:rows,opportunitaMissioni:[{pixelOpportunitaId:118},{pixelOpportunitaId:120}],
 veicoloId:353,postiTotali:10,fingerprintRichiesta:r=>`TEST_ONLY_${r.id}`};
assert.throws(()=>preparaCicloPixelPerPersistenza({...options,economia:{economicamenteAttivabile:false}}),/economicamente attivabile/);
pass('Adapter rifiuta economia negativa');
assert.throws(()=>preparaCicloPixelPerPersistenza({...options,economia:undefined}),/economicamente attivabile/);
pass('Adapter rifiuta economia non verificata');
assert.throws(()=>preparaCicloPixelPerPersistenza({...options,richiesteBloccate:rows.map((r,i)=>i? r:{...r,stato:'in_attesa'}),economia:{economicamenteAttivabile:true}}),/non disponibile/);
pass('Adapter rifiuta richiesta non in_lavorazione');
assert.throws(()=>preparaCicloPixelPerPersistenza({...options,richiesteBloccate:rows.map((r,i)=>i? r:{...r,cliente_id:null}),economia:{economicamenteAttivabile:true}}),/dati incompleti/);
pass('Adapter rifiuta cliente_id assente');
// SOLO test positivo del contratto: economia TRUE SINTETICA, non reale.
// Nessun risultato viene scritto nel database o presentato come attivabile.
const prepared=preparaCicloPixelPerPersistenza({...options,economia:{economicamenteAttivabile:true}});
assert.equal(prepared.piano.attivabile,false);
assert.equal(prepared.piano.requestSnapshot.length,6);
assert.deepEqual(prepared.missioniPersistibili.map(m=>m.pixelOpportunitaId),[118,120]);
assert.deepEqual(prepared.missioniPersistibili.map(m=>m.requests.map(r=>r.id)),[ids1,ids2]);
for(let i=0;i<2;i++){
 const m=prepared.missioniPersistibili[i], meta=prepared.piano.missioni[i];
 for(const r of m.requests){
  const global=prepared.piano.evaluation.requests.find(x=>x.id===r.id);
  assert.equal(global.start,meta.startIndex+r.start);
  assert.equal(global.end,meta.startIndex+r.end);
 }
}
pass('Contratto sintetico positivo: mapping locale/globale, snapshot, opportunità PIXEL');
console.log('ESITO: PASS — SOLO contratti puri; nessuna transazione, routing reale o attivazione.');
