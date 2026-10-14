import assert from 'node:assert/strict';
import { scegliAttivazioni, economiaCandidato } from '../services/popbus/v2/model.js';
const T = Date.now() + 86400000;
let passed=0;
function test(label,fn){try{fn();passed++;console.log('✅ '+label)}catch(e){console.error('❌ '+label,e.message);process.exitCode=1}}
function c(id,gross,km,{vehicle=id,request=id,start=T,end=T+3600000,cap=4,peak=1,classe='EXPRESS',approach=0,mission=km,back=0}={}){
 return {plan:{nodes:[id*2,id*2+1],classe,legs:[{metres:mission*1000,seconds:600}]},
 vehicle:{id:vehicle,posti_totali:cap,euro_km:1},evaluation:{revenue:gross,peak,requests:[{id:request}]},
 ricaviRichiesteEuro:[gross],cost:km,approach:{metres:approach*1000,seconds:0},returnTrip:{metres:back*1000,seconds:0},busyStart:start,busyEnd:end};
}
test('01 — Perdita netta respinta',()=>assert.equal(scegliAttivazioni([c(1,90,80)]).length,0));
test('02 — Pareggio lordo respinto',()=>assert.equal(scegliAttivazioni([c(2,80,80)]).length,0));
test('03 — Copertura netta ammessa',()=>assert.equal(scegliAttivazioni([c(3,100,80)]).length,1));
test('04 — Ritorno incluso',()=>{const x=c(4,90,80,{mission:60,back:20});assert.equal(economiaCandidato(x).margineEuro,-3.5);assert.equal(scegliAttivazioni([x]).length,0)});
test('05 — Ordinamento margine netto',()=>{const a=c(5,200,170,{request:777}),b=c(6,100,75,{request:777});assert.equal(scegliAttivazioni([a,b])[0],b)});
test('06 — Intervallo mancante respinto',()=>{const x=c(7,100,80);delete x.busyStart;delete x.busyEnd;assert.equal(scegliAttivazioni([x]).length,0)});
test('07 — Capienza insufficiente',()=>assert.equal(scegliAttivazioni([c(8,100,80,{cap:2,peak:3})]).length,0));
test('08 — Richiesta unica',()=>assert.equal(scegliAttivazioni([c(9,100,80,{request:99}),c(10,110,80,{request:99})]).length,1));
test('09 — Stesso veicolo sovrapposto',()=>assert.equal(scegliAttivazioni([c(11,100,80,{vehicle:90}),c(12,110,80,{vehicle:90})]).length,1));
test('10 — Stesso veicolo intervalli distinti',()=>assert.equal(scegliAttivazioni([c(13,100,80,{vehicle:90}),c(14,110,80,{vehicle:90,start:T+7200000,end:T+10800000})]).length,2));
test('11 — Classi distinte',()=>assert.equal(scegliAttivazioni([c(15,100,80,{classe:'SAVER'}),c(16,100,80,{classe:'STANDARD'})]).length,2));
test('12 — Manomissione costo respinta',()=>{const x=c(17,100,80);x.cost=50;assert.equal(scegliAttivazioni([x]).length,0)});
test('13 — Ricavi per richiesta obbligatori',()=>{const x=c(18,100,80);delete x.ricaviRichiesteEuro;assert.equal(scegliAttivazioni([x]).length,0)});
test('14 — Tariffa non valida respinta',()=>{const x=c(19,100,80);x.vehicle.euro_km=NaN;assert.equal(scegliAttivazioni([x]).length,0)});
test('15 — Nessuna scrittura DB',()=>assert.equal(typeof scegliAttivazioni,'function'));
console.log(`\n${passed}/15 test superati — SHADOW, nessun DB, nessuna attivazione`);
if(passed!==15)process.exitCode=1;
