// TURENTU TEST 22 — stress avversario ricerca locale classica vs indicizzata vs MILP
// SOLA LETTURA. Nessun accesso DB, worker, HTTP o routing remoto.
// Eseguire da project-root: node tests\test_pixel_popbus_stress_avversario_indicizzato_readonly.mjs
// Opzioni: TURENTU_TEST22_GROUPS=10,50,150 ; TURENTU_TEST21_LOCAL_MS=500
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {scegliAttivazioni,economiaCandidato} from '../services/popbus/v2/model.js';
import {valutaEconomiaCiclo} from '../services/popbus/v2/cycle-pricing.js';
const round=(n,d=2)=>+Number(n).toFixed(d);
const ms=()=>performance.now();
const overlap=(a,b)=>a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd;
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
   if a['busyStart']<b['busyEnd'] and b['busyStart']<a['busyEnd']:constraints.append([i,j])
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

const LOCAL_MAX_MS=Math.max(5,Math.min(60000,Number(process.env.TURENTU_TEST21_LOCAL_MS||500)));
const LOCAL_MAX_EVAL=Math.max(100,Math.min(2000000,Number(process.env.TURENTU_TEST21_LOCAL_EVAL||30000)));
const LOCAL_NEIGHBORS=Math.max(4,Math.min(100,Number(process.env.TURENTU_TEST21_LOCAL_NEIGHBORS||24)));
const LOCAL_PASSES=Math.max(1,Math.min(100,Number(process.env.TURENTU_TEST21_LOCAL_PASSES||12)));
function localImprove(rows,initial){
 const t0=ms();let current=[...initial],evaluations=0,passes=0,changes=[],stop=null;
 if(!validate(rows,current))throw Error('POPBUS iniziale contiene conflitti');
 const conflict=(a,b)=>a.reqIds.some(q=>b.reqIds.includes(q))||(a.vehicleId===b.vehicleId&&overlap(a,b));
 const feasible=(rem,add)=>{const drop=new Set(rem),keep=current.filter(i=>!drop.has(i));const combo=[...keep,...add];
  // Check locale indipendente da MILP, stesso modello di conflitti del Test 17.
  return validate(rows,combo)};
 while(passes<LOCAL_PASSES){
  const taken=new Set(current),outs=rows.map((_,i)=>i).filter(i=>!taken.has(i)&&rows[i].cents>0).sort((a,b)=>rows[b].cents-rows[a].cents);
  let best=null,bestGain=0;
  const consider=(removed,added,type)=>{
   if(evaluations>=LOCAL_MAX_EVAL||ms()-t0>=LOCAL_MAX_MS){stop=evaluations>=LOCAL_MAX_EVAL?'budget_valutazioni':'budget_tempo';return false}
   evaluations++;const gain=added.reduce((s,i)=>s+rows[i].cents,0)-removed.reduce((s,i)=>s+rows[i].cents,0);
   if(gain<=bestGain||!feasible(removed,added))return true;
   bestGain=gain;best={removed,added,type,gain};return true;
  };
  // Candidate che confliggono con al piu 2 selezionate: potenziali sostituzioni 0->1,1->1,2->1.
  for(const a of outs){const blockers=current.filter(i=>conflict(rows[i],rows[a]));if(blockers.length<=2){
    if(!consider(blockers,[a],`${blockers.length}->1`))break;
  }}
  if(stop)break;
  // Ricerca 1->2: restringe le coppie ai vicini con margine alto e/o in conflitto con la stessa scelta.
  for(const r of current){
   const eligible=outs.filter(a=>current.every(i=>i===r||!conflict(rows[i],rows[a]))).slice(0,LOCAL_NEIGHBORS);
   for(let i=0;i<eligible.length;i++){
    for(let j=i+1;j<eligible.length;j++){
     const a=eligible[i],b=eligible[j];if(rows[a].cents+rows[b].cents<=rows[r].cents||conflict(rows[a],rows[b]))continue;
     if(!consider([r],[a,b],'1->2'))break;
    }if(stop)break;
   }if(stop)break;
  }
  if(stop)break;
  if(!best)break;
  const removed=new Set(best.removed);current=[...current.filter(i=>!removed.has(i)),...best.added];
  changes.push({tipo:best.type,guadagnoEuro:round(best.gain/100),escono:best.removed,entrano:best.added});passes++;
 }
 if(!stop&&passes>=LOCAL_PASSES)stop='limite_passate';
 return {ids:current,mosseValutate:evaluations,passate:passes,stopBudget:stop,mosse:changes,tempoMs:round(ms()-t0)};
}
// Ricerca locale indicizzata: conflitti precalcolati per richieste e intervalli veicolo.
// Ogni mossa e controllata con indice e validata nuovamente con validate indipendente.
function indexedImprove(rows,initial){
 const t0=ms(),n=rows.length,adj=Array.from({length:n},()=>new Set());
 const byReq=new Map(),byVehicle=new Map();
 for(let i=0;i<n;i++){
  for(const q of rows[i].reqIds){const k=String(q);if(!byReq.has(k))byReq.set(k,[]);byReq.get(k).push(i)}
  const k=String(rows[i].vehicleId);if(!byVehicle.has(k))byVehicle.set(k,[]);byVehicle.get(k).push(i);
 }
 const edge=(i,j)=>{if(i===j)return;adj[i].add(j);adj[j].add(i)};
 for(const ids of byReq.values())for(let a=0;a<ids.length;a++)for(let b=a+1;b<ids.length;b++)edge(ids[a],ids[b]);
 for(const ids of byVehicle.values()){
  ids.sort((a,b)=>rows[a].busyStart-rows[b].busyStart);
  for(let a=0;a<ids.length;a++)for(let b=a+1;b<ids.length&&rows[ids[b]].busyStart<rows[ids[a]].busyEnd;b++)
   if(overlap(rows[ids[a]],rows[ids[b]]))edge(ids[a],ids[b]);
 }
 const indexMs=ms()-t0;
 let current=[...initial],evaluations=0,passes=0,stop=null,changes=[];
 if(!validate(rows,current))throw Error('POPBUS iniziale non valido');
 const budget=()=>{if(evaluations>=LOCAL_MAX_EVAL){stop='budget_valutazioni';return false}if(ms()-t0>=LOCAL_MAX_MS){stop='budget_tempo';return false}return true};
 while(passes<LOCAL_PASSES){
  if(!budget())break;
  const chosen=new Set(current),outs=rows.map((_,i)=>i).filter(i=>!chosen.has(i)&&rows[i].cents>0).sort((a,b)=>rows[b].cents-rows[a].cents||a-b);
  const blockers=new Map();for(const a of outs){const b=[...adj[a]].filter(i=>chosen.has(i));blockers.set(a,b)}
  let best=null,bestGain=0;
  const consider=(removed,added,type)=>{
   if(!budget())return false;
   evaluations++;
   const gain=added.reduce((z,i)=>z+rows[i].cents,0)-removed.reduce((z,i)=>z+rows[i].cents,0);
   if(gain<=bestGain)return true;
   const removedSet=new Set(removed),addedSet=new Set(added);
   if(addedSet.size!==added.length||added.some(i=>chosen.has(i)&&!removedSet.has(i)))return true;
   if(added.some(i=>[...adj[i]].some(j=>chosen.has(j)&&!removedSet.has(j))))return true;
   if(added.length===2&&adj[added[0]].has(added[1]))return true;
   best={removed,added,type,gain};bestGain=gain;return true;
  };
  for(const a of outs){const b=blockers.get(a);if(b.length<=2&&!consider(b,[a],`${b.length}->1`))break}
  if(stop)break;
  // Stesso vicinato del Test 20, ma senza scansione completa della soluzione a ogni prova.
  for(const r of current){
   const eligible=outs.filter(a=>blockers.get(a).every(i=>i===r)).slice(0,LOCAL_NEIGHBORS);
   for(let i=0;i<eligible.length;i++){
    for(let j=i+1;j<eligible.length;j++){
     const a=eligible[i],b=eligible[j];
     if(rows[a].cents+rows[b].cents<=rows[r].cents||adj[a].has(b))continue;
     if(!consider([r],[a,b],'1->2'))break;
    }if(stop)break;
   }if(stop)break;
  }
  if(stop||!best)break;
  const drop=new Set(best.removed),next=[...current.filter(i=>!drop.has(i)),...best.added];
  if(!validate(rows,next))throw Error('BUG indice conflitti: mossa non valida');
  current=next;passes++;changes.push({tipo:best.type,guadagnoEuro:round(best.gain/100),escono:best.removed,entrano:best.added});
 }
 if(!stop&&passes>=LOCAL_PASSES)stop='limite_passate';
 return {ids:current,mosseValutate:evaluations,passate:passes,stopBudget:stop,mosse:changes,indiceMs:round(indexMs),tempoMs:round(ms()-t0),archiConflitto:adj.reduce((z,a)=>z+a.size,0)/2};
}
function metrics(rows,ids){const a=ids.map(i=>rows[i]);return {cicli:a.length,richiesteServite:new Set(a.flatMap(x=>x.reqIds)).size,margineEuro:round(a.reduce((s,x)=>s+x.cents,0)/100),commissioneEuro:round(a.reduce((s,x)=>s+x.commissionCents,0)/100),km:round(a.reduce((s,x)=>s+x.km,0))}}
function validate(rows,ids){const used=new Set(),byVehicle=new Map();for(const i of ids){if(!Number.isInteger(i)||i<0||i>=rows.length)return false;const r=rows[i];for(const q of r.reqIds){if(used.has(q))return false;used.add(q)}for(const a of byVehicle.get(r.vehicleId)||[])if(overlap(a,r))return false;if(!byVehicle.has(r.vehicleId))byVehicle.set(r.vehicleId,[]);byVehicle.get(r.vehicleId).push(r)}return true}

const GROUPS=(process.env.TURENTU_TEST22_GROUPS||'10,50,150').split(',').map(Number).filter(n=>Number.isInteger(n)&&n>=1&&n<=500);
if(!GROUPS.length)throw Error('TURENTU_TEST22_GROUPS non valido');
const results={test:'TURENTU TEST 22 — AVVERSARI INDICIZZATI',modalita:'SOLA LETTURA; selettore reale; ricerca locale sperimentale; dati sintetici',limiti:['Singole missioni, senza concatenazioni o routing reale','Budget condivisi in configurazione, ma tempi e stop possono differire','MILP solo sulle sei fixture piccole','Non certifica il worker di produzione'],scenari:[],passed:0,failed:0};
const add=(checks,name,pass)=>checks.push({name,pass:!!pass});
function run(name,candidates,withMilp=false){
 const checks=[];
 try{
  const rows=candidates.map(c=>({label:c.label,vehicleId:c.vehicle.id,ownerId:c.vehicle.driver_id,reqIds:c.evaluation.requests.map(r=>r.id),busyStart:c.busyStart,busyEnd:c.busyEnd,cents:economiaCandidato(c).centesimi.margine,commissionCents:0,km:0}));
  const t=ms(),chosen=scegliAttivazioni(candidates),popMs=round(ms()-t);
  const initial=chosen.map(c=>candidates.indexOf(c));
  add(checks,'Candidate con economia positiva',rows.every(r=>r.cents>0));
  add(checks,'POPBUS senza conflitti',validate(rows,initial));
  add(checks,'POPBUS seleziona candidate originali',initial.every(i=>i>=0));
  const classic=localImprove(rows,initial),indexed=indexedImprove(rows,initial);
  const a=metrics(rows,initial),b=metrics(rows,classic.ids),c=metrics(rows,indexed.ids);
  add(checks,'Locale classica senza conflitti',validate(rows,classic.ids));
  add(checks,'Locale indicizzata senza conflitti',validate(rows,indexed.ids));
  add(checks,'Classica non peggiora POPBUS',b.margineEuro>=a.margineEuro);
  add(checks,'Indicizzata non peggiora POPBUS',c.margineEuro>=a.margineEuro);
  add(checks,'Indice e classica uguale se entrambe completano',classic.stopBudget||indexed.stopBudget||b.margineEuro===c.margineEuro);
  let oracle=null;
  if(withMilp){
   oracle=solve(rows);const opt=metrics(rows,oracle.selected);
   add(checks,'MILP certificato',oracle.certified&&oracle.gap===0);
   add(checks,'MILP senza conflitti',validate(rows,oracle.selected));
   add(checks,'Indicizzata non supera MILP',c.margineEuro<=opt.margineEuro);
   add(checks,'Indicizzata recupera ottimo nelle fixture',c.margineEuro===opt.margineEuro);
   oracle={...oracle,metriche:opt};
  }
  const passed=checks.filter(x=>x.pass).length,failed=checks.length-passed;
  results.passed+=passed;results.failed+=failed;
  results.scenari.push({name,candidate:rows.length,popbus:a,localeClassica:b,localeIndicizzata:c,deltaClassicaEuro:round(b.margineEuro-a.margineEuro),deltaIndicizzataEuro:round(c.margineEuro-a.margineEuro),tempiMs:{popbus:popMs,classica:classic.tempoMs,indicizzata:indexed.tempoMs,indice:indexed.indiceMs},ricercaClassica:{mosseValutate:classic.mosseValutate,passate:classic.passate,stopBudget:classic.stopBudget,mosse:classic.mosse},ricercaIndicizzata:{mosseValutate:indexed.mosseValutate,passate:indexed.passate,stopBudget:indexed.stopBudget,mosse:indexed.mosse,archiConflitto:indexed.archiConflitto},milp:oracle,checks,passed,failed});
 }catch(e){results.failed++;results.scenari.push({name,error:String(e.stack||e)})}
}
for(const f of fixtures)run(f.name,f.build(),true);
// Repliche indipendenti della trappola COPERTURA_VS_MARGINE, con ID di richieste e veicoli distinti.
// Ogni gruppo contiene A(2 richieste), B e C (singole alte), D (extra indipendente).
for(const groups of GROUPS){
 const candidates=[];
 for(let g=0;g<groups;g++){
  const q=100000+g*10,v=100000+g*10,owner=90000+g;
  candidates.push(make(`G${g}_A_due`,[q+1,q+2],v+1,owner,40));
  candidates.push(make(`G${g}_B_uno`,[q+1],v+2,owner,100));
  candidates.push(make(`G${g}_C_due`,[q+2],v+3,owner,100));
  candidates.push(make(`G${g}_D_extra`,[q+3],v+4,owner,50));
 }
 run(`STRESS_AVVERSARIO_${groups}_GRUPPI`,candidates,false);
}
console.log(JSON.stringify(results,null,2));if(results.failed)process.exitCode=1;
