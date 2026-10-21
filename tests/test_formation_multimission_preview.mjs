// Test isolato e deterministico: nessuna connessione DB o API esterna.
// Salvare in tests/test_formation_multimission_preview.mjs
import assert from 'node:assert/strict';
import { anteprimaCicliMultimissione } from '../services/popbus/v2/formation-multimission-preview.js';

const now = Date.parse('2026-10-21T10:00:00Z');
const a = { pixelOpportunitaId:118, validated:true,
  from:{lat:40.35,lon:18.17}, to:{lat:40.50,lon:18.40},
  departure:Date.parse('2026-11-01T13:15:00Z'), arrival:Date.parse('2026-11-01T14:15:00Z'),
  kmMissione:55.82, peak:4, requests:[{id:196,prezzo:7},{id:197,prezzo:9},{id:198,prezzo:14}] };
const b = { pixelOpportunitaId:120, validated:true,
  from:{lat:40.50,lon:18.40}, to:{lat:40.35,lon:18.17},
  departure:Date.parse('2026-11-01T15:15:00Z'), arrival:Date.parse('2026-11-01T16:15:00Z'),
  kmMissione:55.82, peak:4, requests:[{id:205,prezzo:7},{id:206,prezzo:9},{id:207,prezzo:14}] };
const vehicle = {id:361,lat:40.3515,lon:18.175,euroKm:0.60,posti_totali:8};
const calls={movement:0,availability:0,conflicts:0,pairs:0};
const deps = {
  missions:[a,b],vehicles:[vehicle],now,
  movement:async (from,to)=>{calls.movement++; return {
    metres:from.lat===to.lat && from.lon===to.lon ? 0 : 5000,
    seconds:from.lat===to.lat && from.lon===to.lon ? 0 : 600
  };},
  isAvailable:async()=>{calls.availability++;return true;},
  hasConflicts:async()=>{calls.conflicts++;return false;},
  validatePair:async()=>{calls.pairs++;return true;}
};
const result=await anteprimaCicliMultimissione(deps);
assert.equal(result.dbWrites,0);
assert.equal(result.simulazione_non_prenotabile,true);
assert.equal(result.cicli.length,1);
assert.deepEqual(result.cicli[0].pixel_opportunita_ids,[118,120]);
assert.equal(result.cicli[0].richiesta_ids.length,6);
assert.equal(result.cicli[0].ricavo_lordo_euro,60);
assert.ok(result.cicli[0].km_ritorno>=0);
assert.ok(calls.movement>0 && calls.availability>0 && calls.conflicts>0 && calls.pairs>0);
const excluded=await anteprimaCicliMultimissione({...deps,validatePair:async()=>false});
assert.equal(excluded.cicli.length,0);
const duplicate={...b,requests:[{id:196,prezzo:14}]};
const rejected=await anteprimaCicliMultimissione({...deps,missions:[a,duplicate]});
assert.equal(rejected.cicli.length,0);
console.log('PASS: Shadow isolato, economia, A/R callback, richieste duplicate, nessuna scrittura');
console.log(JSON.stringify({coppie_ammesse:result.coppie_ammesse,coppie_valutate:result.coppie_valutate,routing_calls:result.routing_calls,migliore:result.migliore},null,2));
console.log('NOTA: missioni, routing, disponibilita e conflitti sono MOCK; non prova fattibilita reale PIXEL.');
