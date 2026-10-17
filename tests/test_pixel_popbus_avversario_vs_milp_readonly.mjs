// TURENTU TEST 18 — fixture avversarie del selettore reale POPBUS V2 vs MILP
// SOLA LETTURA. Nessun DB, worker, routing remoto o scrittura.
// Eseguire: node tests\test_pixel_popbus_avversario_vs_milp_readonly.mjs
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {scegliAttivazioni,economiaCandidato} from '../services/popbus/v2/model.js';
import {valutaEconomiaCiclo} from '../services/popbus/v2/cycle-pricing.js';
const round=n=>Math.round(n*100)/100;
const T=Date.now()+86400000;
const PY=String.raw`import json,sys,time
import numpy as np
from scipy.optimize import milp,Bounds,LinearConstraint
from scipy.sparse import lil_matrix
p=json.load(sys.stdin);r=p['rows'];n=len(r);constraints=[];byreq={};byv={}
for i,x in enumerate(r):
 for q in x['reqIds']:byreq.setdefault(q,[]).append(i)
 byv.setdefault(str(x['vehicleId']),[]).append(i)
for ids in byreq.values():constraints.append(ids)
for ids in byv.values():
 for k,i in enumerate(ids):
  for j in ids[k+1:]:
   a,b=r[i],r[j]
   if a['start']<b['end'] and b['start']<a['end']:constraints.append([i,j])
A=lil_matrix((len(constraints),n),dtype=float)
for k,ids in enumerate(constraints):A[k,ids]=1
s=time.perf_counter();res=milp(c=-np.array([x['cents'] for x in r],dtype=float),integrality=np.ones(n),bounds=Bounds(np.zeros(n),np.ones(n)),constraints=LinearConstraint(A.tocsr(),0,1),options={'time_limit':10,'mip_rel_gap':0.0})
print(json.dumps({'status':int(res.status),'certified':res.status==0,'selected':[i for i,v in enumerate(res.x) if v>.5] if res.x is not None else [],'constraints':len(constraints),'solverMs':round((time.perf_counter()-s)*1000,2),'gap':float(res.mip_gap) if getattr(res,'mip_gap',None) is not None else None}))`;
function solve(rows){const args={input:JSON.stringify({rows}),encoding:'utf8',timeout:40000,maxBuffer:1024*1024};const custom=process.env.TURENTU_PYTHON;let p=spawnSync(custom||'py',custom?['-c',PY]:['-3','-c',PY],args);if(p.error?.code==='ENOENT'&&!custom)p=spawnSync('python',['-c',PY],args);if(p.status!==0)throw Error('Solver non disponibile: '+(p.stderr||p.error?.message||p.stdout||p.status));return JSON.parse(p.stdout)}
let serial=0;
function make(label,reqIds,vehicleId,ownerId,price,minutes=[0,30],km=10){
 const vehicle={id:vehicleId,driver_id:ownerId,posti_totali:12,euro_km:0.5};
 const prices=reqIds.map((_,i)=>i===0?price:0);
 const econ=valutaEconomiaCiclo({ricaviRichiesteEuro:prices,kmAvvicinamento:1,kmMissioni:km,kmTrasferimenti:0,kmRitornoBase:1,euroKm:vehicle.euro_km});
 const departure=T+minutes[0]*60000,arrival=T+minutes[1]*60000;
 const c={label,vehicle,plan:{nodes:[++serial,++serial],legs:[{metres:km*1000,seconds:1200}]},evaluation:{requests:reqIds.map(id=>({id,start:0,end:1})),peak:reqIds.length,revenue:price,departure,arrival},approach:{metres:1000,seconds:60},returnTrip:{metres:1000,seconds:60},ricaviRichiesteEuro:prices,cost:econ.centesimi.costoCompleto/100,busyStart:departure,busyEnd:arrival};
 const check=economiaCandidato(c);if(!check?.economicamenteAttivabile||check.centesimi.margine!==econ.centesimi.margine)throw Error('Fixture economia non valida: '+label);
 return c;
}
// Le fixture costruiscono deliberatamente conflitti che possono ingannare un ordinamento greedy.
const fixtures=[
 {name:'TRAPPOLA_NUMERO_RICHIESTE',expected:'MILP_SUPERIORE',build:()=>[
  make('A_due_passeggeri',[1,2],101,900,40),make('B_singola_alta',[1],102,900,100),make('C_singola_alta',[2],103,900,100)]},
 {name:'TRAPPOLA_MARGINE_LOCALE',expected:'MILP_SUPERIORE',build:()=>[
  make('A_grande',[11],111,910,100,[10,40]),make('B_media',[12],111,910,65,[0,25]),make('C_media',[13],111,910,65,[25,50])]},
 {name:'STESSO_VEICOLO_SENZA_OVERLAP',expected:'PARITA',build:()=>[
  make('A_prima',[21],121,920,70,[0,25]),make('B_dopo',[22],121,920,70,[25,50])]},
 {name:'STESSO_TITOLARE_VEICOLI_DIVERSI',expected:'PARITA',build:()=>[
  make('A_veicolo_1',[31],131,930,70),make('B_veicolo_2',[32],132,930,70)]},
 {name:'SOVRAPPOSIZIONE_STESSO_VEICOLO',expected:'PARITA',build:()=>[
  make('A_preferita',[41],141,940,100,[0,30]),make('B_secondaria',[42],141,940,70,[10,40])]},
 {name:'COPERTURA_VS_MARGINE',expected:'MILP_SUPERIORE',build:()=>[
  make('A_due',[51,52],151,950,40),make('B_uno',[51],152,950,100),make('C_due',[52],153,950,100),make('D_extra',[53],154,950,50)]}
];
function valid(rows,ids){const req=new Set(),byv=new Map();for(const i of ids){const r=rows[i];if(!r)return false;for(const q of r.reqIds){if(req.has(q))return false;req.add(q)}for(const p of byv.get(r.vehicleId)||[])if(p.start<r.end&&r.start<p.end)return false;if(!byv.has(r.vehicleId))byv.set(r.vehicleId,[]);byv.get(r.vehicleId).push(r)}return true}
function metrics(rows,ids){const chosen=ids.map(i=>rows[i]);return {candidate:chosen.map(x=>x.label),cicli:ids.length,richiesteServite:new Set(chosen.flatMap(x=>x.reqIds)).size,margineEuro:round(chosen.reduce((s,x)=>s+x.cents,0)/100)}}
const output={test:'TURENTU TEST 18 — SELEZIONE AVVERSARIA POPBUS V2 VS MILP',mode:'SOLA LETTURA; funzione reale scegliAttivazioni; fixture sintetiche; MILP SciPy HiGHS',limits:['Fixture costruite, non traffico reale o output del worker.','Solo singole missioni nel contratto POPBUS V2; nessuna concatenazione adapter.','L obiettivo MILP e massimizzare il margine; non massimizza direttamente la copertura.','Il margine include ritorno alla base tramite valutaEconomiaCiclo.','Non modifica database, backend o worker.'],scenari:[],passed:0,failed:0};
for(const f of fixtures){try{const candidates=f.build();const rows=candidates.map(c=>({label:c.label,vehicleId:c.vehicle.id,ownerId:c.vehicle.driver_id,reqIds:c.evaluation.requests.map(r=>r.id),start:c.busyStart,end:c.busyEnd,cents:economiaCandidato(c).centesimi.margine}));const t=performance.now();const selected=scegliAttivazioni(candidates);const popMs=round(performance.now()-t);const popIds=selected.map(c=>candidates.indexOf(c));const milp=solve(rows);const a=metrics(rows,popIds),b=metrics(rows,milp.selected);const delta=round(b.margineEuro-a.margineEuro);const checks=[{name:'Economia valida',pass:rows.every(r=>r.cents>0)},{name:'POPBUS senza conflitti',pass:valid(rows,popIds)},{name:'MILP senza conflitti',pass:valid(rows,milp.selected)},{name:'MILP ottimo certificato',pass:milp.certified&&milp.gap===0},{name:'MILP non inferiore',pass:delta>=0},{name:'Esito avversario atteso',pass:f.expected==='MILP_SUPERIORE'?delta>0:delta===0}];const passed=checks.filter(c=>c.pass).length,failed=checks.length-passed;output.scenari.push({name:f.name,expected:f.expected,candidate:rows.length,popbus:a,milp:b,deltaMargineEuro:delta,tempoPopbusMs:popMs,solver:{certified:milp.certified,gap:milp.gap,status:milp.status,solverMs:milp.solverMs,vincoli:milp.constraints},checks,passed,failed});output.passed+=passed;output.failed+=failed}catch(e){output.scenari.push({name:f.name,error:String(e.stack||e)});output.failed++}}
console.log(JSON.stringify(output,null,2));if(output.failed)process.exitCode=1;
