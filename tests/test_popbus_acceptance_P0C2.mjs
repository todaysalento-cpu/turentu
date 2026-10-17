// TURENTU POPBUS P0-C2 — SQL MOCK, nessun DB/Stripe.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verificaMissioniPersistite } from '../services/popbus/v2/popbus-multimission-db-preflight.js';
const acceptance=readFileSync('services/popbus/v2/acceptance.js','utf8');
assert.match(acceptance,/await verificaMissioniPersistite\(client/);
assert.match(acceptance,/Accettazione ciclo multi-missione non ancora abilitata/);
console.log('PASS Acceptance verifica DB e mantiene guardia');
const departure=Date.parse('2027-04-01T10:00:00Z');
const nodes=Array.from({length:8},(_,i)=>i+1);
const legs=Array.from({length:7},()=>({seconds:60,metres:100,polyline:'??_ibE_ibE'}));
const req=[{id:101,start:0,end:1},{id:102,start:3,end:4},{id:103,start:6,end:7}];
const missioni=[{ordine:1,startIndex:0,endIndex:1},{ordine:2,startIndex:3,endIndex:4},{ordine:3,startIndex:6,endIndex:7}].map((m,i)=>({...m,partenza:departure+m.startIndex*60000,arrivo:departure+m.endIndex*60000}));
const piano={tipoPiano:'CICLO_PIXEL_CORSA_UNICA_V1',veicoloId:353,nodes,coordinates:nodes.map(id=>({id,lat:40,lon:18})),legs,busyStart:new Date(departure-60000).toISOString(),busyEnd:new Date(departure+480000).toISOString(),evaluation:{departure,arrival:departure+420000,times:nodes.map((_,i)=>i*60000),requests:req},missioni};
const baseM=missioni.map((m,i)=>({id:501+i,ordine:i+1,nodi_territoriali:nodes.slice(m.startIndex,m.endIndex+1),partenza:new Date(m.partenza),arrivo:new Date(m.arrivo),piano:{nodes:nodes.slice(m.startIndex,m.endIndex+1),legs:legs.slice(m.startIndex,m.endIndex),requests:[{id:req[i].id,start:0,end:1}]}}));
const baseL=req.map((r,i)=>({missione_id:501+i,richiesta_id:r.id,indice_salita:0,indice_discesa:1}));
const baseG=req.map(r=>({richiesta_id:r.id,indice_salita:r.start,indice_discesa:r.end,attiva:true}));
const baseR=req.map((r,i)=>({id:r.id,posti_richiesti:[2,3,2][i],stato:'in_lavorazione',corsa_id:null}));
const clone=x=>structuredClone(x);
function mock(overrides={}) { const data={missioni:clone(baseM),locali:clone(baseL),globali:clone(baseG),richieste:clone(baseR),...overrides};const queries=[];return {queries,query:async(sql,args)=>{queries.push({sql,args});if(sql.includes('FROM public.popbus_missione_richieste'))return {rows:data.locali};if(sql.includes('FROM public.popbus_attivazione_richieste'))return {rows:data.globali};if(sql.includes('FROM public.richieste_pop_bus'))return {rows:data.richieste};if(sql.includes('FROM public.popbus_attivazione_missioni'))return {rows:data.missioni};throw Error('SQL inatteso');}};}
const args={attivazioneId:88,piano,veicoloId:353,postiTotali:4};
const db=mock();const ok=await verificaMissioniPersistite(db,args);
assert.deepEqual([ok.missioniPersistite,ok.richiesteVerificate,ok.peak,ok.totalePasseggeri],[3,3,3,7]);
assert.equal(db.queries.length,4);assert(db.queries.every(q=>/^\s*SELECT\b/i.test(q.sql)));
console.log('PASS 3 missioni, 3 richieste, picco 3 su 7 passeggeri; sole SELECT');
async function rejects(label,overrides,needle){const m=mock(overrides);await assert.rejects(()=>verificaMissioniPersistite(m,args),needle);assert(m.queries.every(q=>/^\s*SELECT\b/i.test(q.sql)));console.log('PASS '+label);}
await rejects('Missione mancante',{missioni:baseM.slice(0,2)},/numero missioni/);
const wrongNodes=clone(baseM);wrongNodes[1].nodi_territoriali=[99,5];await rejects('Nodi persistiti alterati',{missioni:wrongNodes},/nodi missione/);
const wrongLocal=clone(baseL);wrongLocal[1].indice_salita=1;await rejects('Indice locale alterato',{locali:wrongLocal},/associazione locale/);
const wrongGlobal=clone(baseG);wrongGlobal[1].indice_salita=2;await rejects('Indice globale alterato',{globali:wrongGlobal},/associazione globale/);
const inactive=clone(baseG);inactive[1].attiva=false;await rejects('Associazione inattiva',{globali:inactive},/associazione globale/);
const tooMany=clone(baseR);tooMany[1].posti_richiesti=5;await rejects('Sovracapienza reale',{richieste:tooMany},/capienza superata/);
const changed=clone(baseR);changed[0].stato='convertita';await rejects('Richiesta già convertita',{richieste:changed},/non disponibili/);
const wrongLegs=clone(baseM);wrongLegs[0].piano.legs[0].polyline='different';await rejects('Tratta persistita alterata',{missioni:wrongLegs},/tratte missione/);
console.log('ESITO: 10 PASS, 0 FAIL. SQL MOCK, nessuna connessione DB/Stripe; guardia multi-missione attiva.');
