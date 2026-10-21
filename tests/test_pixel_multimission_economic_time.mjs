// Test isolato e riproducibile: nessun database, nessuna modifica LIVE.
import assert from 'node:assert/strict';
import { ottimizzaAttesaDueMissioni } from '../services/popbus/v2/pixel-multimission-economic-time-optimizer.js';
const t=s=>Date.parse(s);
const from={lat:40.1,lon:18.1}, to={lat:40.2,lon:18.2};
const mission=(id,lo,hi,dep,durMin)=>({
  pixelOpportunitaId:id,lower:t(lo),upper:t(hi),departure:t(dep),
  arrival:t(dep)+durMin*60000,from,to,requests:[{id:id*10,prezzo:10}],validated:true
});
const a=mission(115,'2026-11-01T13:15:00Z','2026-11-01T13:30:00Z','2026-11-01T13:15:00Z',28.5666666667);
const b=mission(119,'2026-11-01T14:00:00Z','2026-11-01T14:15:00Z','2026-11-01T14:00:00Z',60.25);
const movement=async()=>({metres:24016,seconds:1651.2});
const validateShiftedMission=async(m,original)=>m.departure>=original.lower && m.departure<=original.upper;
const r=await ottimizzaAttesaDueMissioni({a,b,movement,validateShiftedMission,costoAttesaOraEuro:12});
assert.equal(r.fattibile,true);
assert.equal(r.recuperata,true);
assert.equal(r.attesa_min,0);
assert.equal(r.costo_attesa_euro,0);
assert.equal(r.partenza_b,'2026-11-01T14:15:00.000Z');
const longA=mission(118,'2026-11-01T13:15:00Z','2026-11-01T13:30:00Z','2026-11-01T13:15:00Z',60.25);
const longB=mission(120,'2026-11-01T14:45:00Z','2026-11-01T15:00:00Z','2026-11-01T14:45:00Z',60.25);
const impossible=await ottimizzaAttesaDueMissioni({a:longA,b:longB,movement:async()=>({metres:53029,seconds:2872.8}),validateShiftedMission});
assert.equal(impossible.fattibile,false);
assert.equal(impossible.stato,'TRASFERIMENTO_IMPOSSIBILE');
const rejected=await ottimizzaAttesaDueMissioni({a,b,movement,validateShiftedMission:async()=>false});
assert.equal(rejected.stato,'VALIDAZIONE_NODI_FALLITA');
console.log('PASS: ottimizzazione attesa, recupero 115->119, esclusione 118->120, validazione fail-closed');
console.log(JSON.stringify({recuperato:r,impossibile:impossible},null,2));
