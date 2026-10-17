// Salvare come tests/test_popbus_assembler_ciclo.mjs
// Eseguire: node tests/test_popbus_assembler_ciclo.mjs
// Sola memoria: nessun database, Stripe o rete.
import assert from 'node:assert/strict';
import { componiCicloInCorsa } from '../services/popbus/v2/popbus-single-corsa-assembler.js';

const nodes = [
  { id: 7, lat: 40.3515, lon: 18.1750, nome_nodo: 'Lecce' },
  { id: 5, lat: 40.1190, lon: 18.2970, nome_nodo: 'Maglie' },
  { id: 8, lat: 39.9300, lon: 18.3600, nome_nodo: 'Tricase' }
];
// Polilinea valida a due punti; testiamo gli indici e i tempi, non la precisione stradale.
function encodePoint(lat, lon) {
  const enc = v => { let x = v < 0 ? ~(v << 1) : v << 1, s = ''; while (x >= 32) { s += String.fromCharCode((32 | (x & 31)) + 63); x >>>= 5; } return s + String.fromCharCode(x + 63); };
  return enc(Math.round(lat * 1e5)) + enc(Math.round(lon * 1e5));
}
function leg(a, b, seconds = 1800, metres = 30000) {
  const x = nodes.find(n => n.id === a), y = nodes.find(n => n.id === b);
  return { seconds, metres, polyline: encodePoint(x.lat, x.lon) + encodePoint(y.lat, y.lon) };
}
const t = Date.parse('2026-10-19T08:00:00Z');
const missions = [
  { corridorId: 'm1', nodes: [7,5], legs: [leg(7,5)], departure: t, arrival: t+1800000, requests: [{id:101,start:0,end:1}] },
  { corridorId: 'm2', nodes: [5,8], legs: [leg(5,8)], departure: t+3000000, arrival: t+4800000, requests: [{id:102,start:0,end:1}] },
  { corridorId: 'm3', nodes: [8,7], legs: [leg(8,7)], departure: t+6000000, arrival: t+7800000, requests: [{id:103,start:0,end:1}] }
];
const transfers = [{ seconds:0, metres:0, attesaMinuti:20 }, { seconds:0, metres:0, attesaMinuti:20 }];
const input = { missioni: missions, trasferimenti: transfers, nodi:nodes, veicoloId:353,
  busyStart: new Date(t-600000).toISOString(), busyEnd:new Date(t+8400000).toISOString(),
  approach:{metres:10000,seconds:600},returnTrip:{metres:10000,seconds:600} };
let ok=0, failed=0;
function check(name, fn) { try { fn(); ok++; console.log('PASS',name); } catch(e) { failed++; console.error('FAIL',name,'-',e.message); } }
function reject(name, change) { check(name, () => { const clone=structuredClone(input); change(clone); assert.throws(()=>componiCicloInCorsa(clone)); }); }
console.log('=== TURENTU POPBUS / ASSEMBLER TRE MISSIONI ===');
let plan;
check('Tre missioni producono un piano unico',()=> { plan=componiCicloInCorsa(input); assert.equal(plan.tipoPiano,'CICLO_PIXEL_CORSA_UNICA_V1'); assert.equal(plan.missioni.length,3); });
if(plan) {
  check('Una sola sequenza di nodi e tratte',()=>assert.equal(plan.coordinates.length,plan.legs.length+1));
  check('Richieste distinte',()=>assert.deepEqual(plan.evaluation.requests.map(r=>r.id),[101,102,103]));
  check('Indici globali coerenti',()=> { for(const r of plan.evaluation.requests) { assert.ok(r.start>=0 && r.end>r.start && r.end<plan.nodes.length); } });
  check('Nodi di salita e discesa corretti',()=>assert.deepEqual(plan.evaluation.requests.map(r=>[plan.nodes[r.start],plan.nodes[r.end]]),[[7,5],[5,8],[8,7]]));
  check('Tempi cumulativi coerenti',()=>assert.equal(plan.evaluation.departure+plan.evaluation.times.at(-1),plan.evaluation.arrival));
  check('Due attese di 20 minuti presenti',()=>assert.equal(plan.legs.filter(l=>l.attesa).reduce((s,l)=>s+l.seconds,0),2400));
  check('Ritorno a Lecce ammesso',()=>assert.equal(plan.nodes.at(-1),7));
  check('Intervallo operativo conservato',()=> {assert.equal(plan.busyStart,input.busyStart);assert.equal(plan.busyEnd,input.busyEnd);});
  check('Piano non attivabile',()=>assert.equal(plan.attivabile,false));
  check('Il piano non calcola peak (lacuna nota)',()=>assert.equal(plan.evaluation.peak,undefined));
  console.log('RIEPILOGO PIANO',JSON.stringify({nodes:plan.nodes,richieste:plan.evaluation.requests,missioni:plan.missioni,legs:plan.legs.length,attivabile:plan.attivabile},null,2));
}
reject('Richiesta duplicata rifiutata',x=>x.missioni[1].requests[0].id=101);
reject('Orario missione incompatibile rifiutato',x=>x.missioni[1].departure+=60000);
reject('Trasferimenti mancanti rifiutati',x=>x.trasferimenti=[]);
reject('Indici locali invalidi rifiutati',x=>x.missioni[2].requests[0].end=3);
reject('Intervallo busy incompleto rifiutato',x=>x.busyEnd=new Date(t+6000000).toISOString());
reject('Geometria assente rifiutata',x=>x.missioni[0].legs[0].polyline='');
console.log(`\nESITO: ${ok} PASS, ${failed} FAIL. Nessuna scrittura.`);
if(failed) process.exitCode=1;
