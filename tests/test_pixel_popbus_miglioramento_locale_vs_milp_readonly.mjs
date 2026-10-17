// TURENTU TEST 19 — POPBUS V2 + ricerca locale vs MILP
// SOLA LETTURA. Nessun DB, worker, routing remoto o scrittura.
// Eseguire: node tests\test_pixel_popbus_miglioramento_locale_vs_milp_readonly.mjs
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

// Ricerca locale sperimentale: parte dalla selezione REALE POPBUS, senza modificarla.
// Mosse ammesse: aggiunta, 1->1, 1->2, 2->1; ogni soluzione deve essere fattibile.
// Si sceglie la mossa col maggiore incremento positivo di margine, ripetendo fino a stallo.
function localImprove(rows, initial, maxPasses=100){
 let current=[...initial];
 if(!valid(rows,current))throw Error('Selezione POPBUS iniziale non valida');
 const score=ids=>ids.reduce((s,i)=>s+rows[i].cents,0);
 const trace=[];let attempted=0,passes=0;
 while(passes++<maxPasses){
  const taken=new Set(current),excluded=rows.map((_,i)=>i).filter(i=>!taken.has(i));
  let best=null,bestGain=0;
  const consider=(removed,added,type)=>{
   attempted++;
   const gain=score(added)-score(removed);
   if(gain<=bestGain)return;
   const rem=new Set(removed);
   const next=[...current.filter(i=>!rem.has(i)),...added];
   if(!valid(rows,next))return;
   bestGain=gain;best={next,removed,added,type,gain};
  };
  for(const a of excluded)consider([],[a],'0->1');
  for(const r of current)for(const a of excluded)consider([r],[a],'1->1');
  for(const r of current)for(let i=0;i<excluded.length;i++)for(let j=i+1;j<excluded.length;j++)consider([r],[excluded[i],excluded[j]],'1->2');
  for(let i=0;i<current.length;i++)for(let j=i+1;j<current.length;j++)for(const a of excluded)consider([current[i],current[j]],[a],'2->1');
  if(!best)break;
  current=best.next;
  trace.push({tipo:best.type,escono:best.removed.map(i=>rows[i].label),entrano:best.added.map(i=>rows[i].label),guadagnoEuro:round(best.gain/100)});
 }
 return {ids:current,trace,mosseValutate:attempted,passate:passes-1,limitePassate:maxPasses,raggiuntoLimite:passes>maxPasses};
}
const output={test:'TURENTU TEST 19 — POPBUS V2 + MIGLIORAMENTO LOCALE VS MILP',mode:'SOLA LETTURA; scegliAttivazioni reale; ottimizzatore locale solo nel test; MILP SciPy HiGHS',limits:['Fixture sintetiche avversarie del Test 18, non dati di produzione.','Ricerca locale limitata a mosse 0->1, 1->1, 1->2 e 2->1; non garantisce ottimo globale.','Il MILP certifica solo l ottimo sulle candidate fornite e sui vincoli modellati.','Tempi su fixture piccole: non dimostrano scalabilita su migliaia di candidate.','Il test non modifica worker, backend, database o file di produzione.'],scenari:[],passed:0,failed:0};
for(const f of fixtures){
 try{
  const candidates=f.build();
  const rows=candidates.map(c=>({label:c.label,vehicleId:c.vehicle.id,ownerId:c.vehicle.driver_id,reqIds:c.evaluation.requests.map(r=>r.id),start:c.busyStart,end:c.busyEnd,cents:economiaCandidato(c).centesimi.margine}));
  const t0=performance.now(),selected=scegliAttivazioni(candidates),popMs=round(performance.now()-t0);
  const popIds=selected.map(c=>candidates.indexOf(c));
  const t1=performance.now(),local=localImprove(rows,popIds),localMs=round(performance.now()-t1);
  const oracle=solve(rows);
  const a=metrics(rows,popIds),b=metrics(rows,local.ids),c=metrics(rows,oracle.selected);
  const deltaLocal=round(b.margineEuro-a.margineEuro),deltaMilp=round(c.margineEuro-b.margineEuro);
  const checks=[
   {name:'Economia delle candidate valida',pass:rows.every(r=>r.cents>0)},
   {name:'POPBUS senza conflitti',pass:valid(rows,popIds)},
   {name:'Ricerca locale senza conflitti',pass:valid(rows,local.ids)},
   {name:'MILP senza conflitti',pass:valid(rows,oracle.selected)},
   {name:'MILP ottimo certificato',pass:oracle.certified&&oracle.gap===0},
   {name:'Ricerca locale non peggiora POPBUS',pass:deltaLocal>=0},
   {name:'Ricerca locale non supera ottimo MILP',pass:deltaMilp>=0},
   {name:'Ricerca locale recupera l ottimo in questa fixture',pass:deltaMilp===0},
   {name:'Nessun limite iterazioni raggiunto',pass:!local.raggiuntoLimite}
  ];
  const passed=checks.filter(x=>x.pass).length,failed=checks.length-passed;
  output.scenari.push({name:f.name,candidate:rows.length,popbus:a,ottimizzazioneLocale:b,milp:c,deltaLocaleVsPopbusEuro:deltaLocal,deltaMilpVsLocaleEuro:deltaMilp,tempiMs:{popbus:popMs,locale:localMs},ricercaLocale:{mosse:local.trace,mosseValutate:local.mosseValutate,passate:local.passate,raggiuntoLimite:local.raggiuntoLimite},solver:{certified:oracle.certified,gap:oracle.gap,status:oracle.status,solverMs:oracle.solverMs,vincoli:oracle.constraints},checks,passed,failed});
  output.passed+=passed;output.failed+=failed;
 }catch(e){output.scenari.push({name:f.name,error:String(e.stack||e)});output.failed++}
}
console.log(JSON.stringify(output,null,2));if(output.failed)process.exitCode=1;
