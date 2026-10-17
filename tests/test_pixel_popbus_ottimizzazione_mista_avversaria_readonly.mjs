// TURENTU TEST 10 — PIXEL P2.1 + adapter POPBUS: cicli da 1/2/3 missioni, selezione flotta.
// SOLA LETTURA. Salvare in tests/test_pixel_popbus_ottimizzazione_cicli_readonly.mjs
import {performance} from 'node:perf_hooks';
import {createIncrementalCorridorEngine} from '../services/pixel/incremental-corridor-engine.js';
import {diagnosticaCicloPixelPopbus} from '../services/pixel/pixel-popbus-cycle-adapter.js';
import {generaCandidate,valutaRichieste} from '../services/popbus/v2/model.js';

const BASE=Date.parse('2030-04-01T10:00:00Z');
const iso=m=>new Date(BASE+m*60000).toISOString();
const N=12, requests=[], nodes=[];
for(let g=0;g<N;g++){
 for(let p=1;p<=4;p++)nodes.push({id:g*10+p,lat:40,lon:18+(g*10+p)*0.001});
 const n=p=>g*10+p;
 // Tre richieste per area, finestre diverse. La richiesta principale parte ogni 75 minuti.
 for(const [j,a,b,offset,price] of [[0,1,2,0,75],[1,2,3,12,45],[2,3,4,24,60]])requests.push({
  id:g*3+j+1,start_node_id:n(a),end_node_id:n(b),
  origine_nodo_territoriale_id:n(a),destinazione_nodo_territoriale_id:n(b),
  start_datetime:iso(g*75+offset),posti_richiesti:1+(g+j)%2,prezzo:price+(g%3)*7,
  classe:'STANDARD',classe_percorrenza:'BASSA',max_fermate_intermedie:10,
  min_km_tra_fermate:0,max_deviazione_pct:100
 });
}
const byId=new Map(requests.map(r=>[r.id,r]));
const byNode=new Map(nodes.map(n=>[n.id,n]));
// Mock coerente tra routing PIXEL e routing adapter, inclusi trasferimenti inter-area.
const leg=(a,b)=>({metres:Math.abs(Number(b)-Number(a))*2000,seconds:Math.abs(Number(b)-Number(a))*120,polyline:`mock-${a}-${b}`});
const routeNodes=async ids=>({verificataRouting:true,legs:ids.slice(1).map((id,i)=>leg(ids[i],id))});
const road=async(a,b)=>leg(Math.round((a.lon-18)/0.001),Math.round((b.lon-18)/0.001));
const engine=createIncrementalCorridorEngine({routeNodes,abilitaVariantiP1:true,maxVariantiPerRichiesta:4,maxNodiVariante:6,tolleranzaMinuti:30});
for(const r of requests)await engine.processRequest(r);
const corridors=engine.listCorridors();
// Ogni missione deriva da un corridoio PIXEL reale, e passa la valutazione POPBUS.
const missionRows=[];
const seen=new Set();
for(const c of corridors){
 for(const group of engine.temporalCandidatesComplete(c.id)){
  const ids=[...group.richiestaIds].map(Number).sort((a,b)=>a-b);
  if(!ids.length||ids.length>3)continue;
  const key=`${c.id}:${ids.join(',')}`;if(seen.has(key))continue;seen.add(key);
  const selected=ids.map(id=>byId.get(id));if(selected.some(x=>!x))continue;
  try{
   const ev=valutaRichieste({nodes:c.nodes,legs:c.legs},selected,ids,{mode:'seeds_only',maxPeak:8});
   if(ev?.requests?.length!==ids.length)continue;
   const g=Math.floor((Number(c.nodes[0])-1)/10);
   if(c.nodes.some(n=>Math.floor((Number(n)-1)/10)!==g))continue;
   missionRows.push({corridorId:c.id,requestIds:ids,departure:ev.departure,arrival:ev.arrival,group:g});
  }catch{}
 }
}
// Includere anche candidate POPBUS reali come verifica indipendente del generatore.
const popbusRaw=generaCandidate(requests,500);
const vehicles=[];
for(let i=0;i<6;i++)vehicles.push({id:2000+i,driver_id:700+Math.floor(i/2),posti_totali:6+(i%2),euro_km:[0.45,0.6,0.8][i%3],lat:byNode.get(1+i*20).lat,lon:byNode.get(1+i*20).lon});
// Le missioni singole hanno una prima partenza per area; concatenazione tra aree vicine.
const ordered=[...missionRows].sort((a,b)=>a.departure-b.departure||a.corridorId-b.corridorId);
const seedByGroup=new Map();
for(const m of ordered)if(!seedByGroup.has(m.group))seedByGroup.set(m.group,m);
const seeds=[...seedByGroup.values()].sort((a,b)=>a.group-b.group);
const plans=[];
for(let i=0;i<seeds.length;i++)for(let k=1;k<=3&&i+k<=seeds.length;k++){
 const seq=seeds.slice(i,i+k);
 if(seq.some((m,j)=>j&&m.group!==seq[j-1].group+1))continue;
 plans.push(seq.map(m=>({corridorId:m.corridorId,requestIds:m.requestIds})));
}
// Altri cicli singoli, sempre generati da PIXEL; limite per mantenere il benchmark ripetibile.
for(const m of ordered.slice(0,50))plans.push([{corridorId:m.corridorId,requestIds:m.requestIds}]);
const planKey=p=>p.map(m=>`${m.corridorId}:${m.requestIds.join(',')}`).join('|');
const uniquePlans=[...new Map(plans.map(p=>[planKey(p),p])).values()];
const checked=[], rejected={};
const t0=performance.now();
for(const p of uniquePlans)for(const v of vehicles){
 const result=await diagnosticaCicloPixelPopbus({engine,missioni:p,richieste:requests,vehicle:v,nodes,road,
  now:Date.parse('2029-01-01T00:00:00Z'),maxWaitMin:180,costoAttesaOraEuro:2,
  validateVehicle:async()=>true,validateCandidate:async()=>true});
 if(!result.ok){rejected[result.motivo]=(rejected[result.motivo]||0)+1;continue;}
 const cents=result.economia?.centesimi?.margine;
 if(!Number.isInteger(cents))throw Error('Margine in centesimi assente');
 checked.push({id:`${v.id}|${planKey(p)}`,vehicleId:v.id,ownerId:v.driver_id,
  reqIds:result.richieste.map(String),busyStart:result.busyStart,busyEnd:result.busyEnd,
  missions:p.length,cents,commissionCents:result.economia.centesimi.commissione,
  km:result.economia.km.totali,validated:result.validazionePreliminare,attivabile:result.attivabile});
}
const diagnosisMs=performance.now()-t0;



// TEST 23 — validazione sperimentale ottimizzatore indicizzato su cicli 1/2/3 missioni.
// Non usa scegliAttivazioni sui cicli concatenati: quel contratto e' stato testato sulle singole missioni.
import {spawnSync} from 'node:child_process';
const clock=()=>performance.now();
const limitMs=Number(process.env.TURENTU_TEST24_LOCAL_MS||500);
const maxPasses=Number(process.env.TURENTU_TEST24_PASSES||20);
const maxEvaluations=Number(process.env.TURENTU_TEST23_EVAL||50000);
const PY=String.raw`import json,sys,time
import numpy as np
from scipy.optimize import milp,Bounds,LinearConstraint
from scipy.sparse import lil_matrix
p=json.load(sys.stdin); r=p['rows']; n=len(r); cons=[]; byreq={}; byveh={}
for i,x in enumerate(r):
 for q in x['reqIds']:byreq.setdefault(str(q),[]).append(i)
 byveh.setdefault(str(x['vehicleId']),[]).append(i)
for v in byreq.values():
 if len(v)>1:cons.append(v)
for v in byveh.values():
 for k,i in enumerate(v):
  for j in v[k+1:]:
   a,b=r[i],r[j]
   if a['busyStart']<b['busyEnd'] and b['busyStart']<a['busyEnd']:cons.append([i,j])
A=lil_matrix((len(cons),n),dtype=float)
for k,v in enumerate(cons):A[k,v]=1
s=time.perf_counter()
res=milp(c=-np.array([x['cents'] for x in r],dtype=float),integrality=np.ones(n),bounds=Bounds(np.zeros(n),np.ones(n)),constraints=LinearConstraint(A.tocsr(),0,1),options={'time_limit':20,'mip_rel_gap':0.0})
print(json.dumps({'status':int(res.status),'certified':bool(res.status==0),'selected':[i for i,x in enumerate(res.x) if x>0.5] if res.x is not None else [],'gap':float(res.mip_gap) if getattr(res,'mip_gap',None) is not None else None,'constraints':len(cons),'solverMs':round((time.perf_counter()-s)*1000,2)}))`;
const sameReq=(a,b)=>a.reqIds.some(q=>b.reqIds.includes(q));
const overlaps=(a,b)=>a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd;
const conflicts=(a,b)=>sameReq(a,b)||(a.vehicleId===b.vehicleId&&overlaps(a,b));
function verify(ids){
 const used=new Set(),byVehicle=new Map(),seen=new Set();
 for(const i of ids){
  if(!Number.isInteger(i)||i<0||i>=rows.length||seen.has(i))return false;
  seen.add(i);const r=rows[i];
  if(!(r.busyStart<r.busyEnd)||!Number.isInteger(r.cents)||r.cents<=0)return false;
  for(const q of r.reqIds){if(used.has(q))return false;used.add(q)}
  for(const old of byVehicle.get(r.vehicleId)||[])if(overlaps(r,old))return false;
  if(!byVehicle.has(r.vehicleId))byVehicle.set(r.vehicleId,[]);byVehicle.get(r.vehicleId).push(r);
 }
 return true;
}
const rows=checked.filter(r=>Number.isFinite(r.busyStart)&&Number.isFinite(r.busyEnd)&&r.busyStart<r.busyEnd&&Number.isInteger(r.cents)&&r.cents>0);
const checks=[];const test=(name,ok)=>checks.push({name,pass:Boolean(ok)});
const graphStart=clock(),adj=Array.from({length:rows.length},()=>new Set());
const reqMap=new Map(),vehicleMap=new Map();
for(let i=0;i<rows.length;i++){
 for(const q of rows[i].reqIds){const k=String(q);if(!reqMap.has(k))reqMap.set(k,[]);reqMap.get(k).push(i)}
 const k=String(rows[i].vehicleId);if(!vehicleMap.has(k))vehicleMap.set(k,[]);vehicleMap.get(k).push(i);
}
function edge(i,j){if(i===j)return;adj[i].add(j);adj[j].add(i)}
for(const ids of reqMap.values())for(let a=0;a<ids.length;a++)for(let b=a+1;b<ids.length;b++)edge(ids[a],ids[b]);
for(const ids of vehicleMap.values()){
 ids.sort((a,b)=>rows[a].busyStart-rows[b].busyStart);
 for(let a=0;a<ids.length;a++)for(let b=a+1;b<ids.length&&rows[ids[b]].busyStart<rows[ids[a]].busyEnd;b++)
  if(overlaps(rows[ids[a]],rows[ids[b]]))edge(ids[a],ids[b]);
}
const indexMs=clock()-graphStart;
let graphMatches=true,edges=0;
for(let i=0;i<rows.length;i++){
 edges+=adj[i].size;
 for(let j=i+1;j<rows.length;j++)if(adj[i].has(j)!==conflicts(rows[i],rows[j]))graphMatches=false;
}
// Greedy iniziale indipendente da POPBUS, necessario per cicli concatenati.
const order=rows.map((_,i)=>i).sort((a,b)=>rows[b].cents-rows[a].cents||a-b);
const greedy=[];for(const i of order)if(greedy.every(j=>!adj[i].has(j)))greedy.push(i);
const initial=[...greedy];let selected=[...initial],moves=[],evaluations=0,stop=null;
const start=clock();
for(let pass=0;pass<maxPasses;pass++){
 if(clock()-start>=limitMs){stop='budget_tempo';break}
 const taken=new Set(selected),out=order.filter(i=>!taken.has(i));
 const blockers=new Map(out.map(i=>[i,[...adj[i]].filter(j=>taken.has(j))]));
 let best=null,bestGain=0;
 function consider(remove,add,type){
  if(evaluations>=maxEvaluations||clock()-start>=limitMs){stop=evaluations>=maxEvaluations?'budget_valutazioni':'budget_tempo';return false}
  evaluations++;
  const gain=add.reduce((s,i)=>s+rows[i].cents,0)-remove.reduce((s,i)=>s+rows[i].cents,0);
  if(gain<=bestGain||add.length===2&&adj[add[0]].has(add[1]))return true;
  const removed=new Set(remove);
  if(add.some(i=>[...adj[i]].some(j=>taken.has(j)&&!removed.has(j))))return true;
  best={remove,add,type,gain};bestGain=gain;return true;
 }
 for(const i of out){const b=blockers.get(i);if(b.length<=2&&!consider(b,[i],`${b.length}->1`))break}
 if(stop)break;
 for(const r of selected){
  const eligible=out.filter(i=>blockers.get(i).every(j=>j===r)).slice(0,24);
  for(let a=0;a<eligible.length;a++){
   for(let b=a+1;b<eligible.length;b++){
    if(!consider([r],[eligible[a],eligible[b]],'1->2'))break;
   }if(stop)break;
  }if(stop)break;
 }
 if(stop||!best)break;
 const removed=new Set(best.remove);const next=[...selected.filter(i=>!removed.has(i)),...best.add];
 if(!verify(next))throw Error('BUG: mossa indicizzata non valida');
 selected=next;moves.push({tipo:best.type,guadagnoEuro:best.gain/100,escono:best.remove,entrano:best.add});
 if(pass===maxPasses-1)stop='limite_passate';
}
const improveMs=clock()-start;
function metrics(ids){const chosen=ids.map(i=>rows[i]);return {cicli:chosen.length,missioni:chosen.reduce((s,r)=>s+r.missions,0),richiesteServite:new Set(chosen.flatMap(r=>r.reqIds)).size,margineEuro:chosen.reduce((s,r)=>s+r.cents,0)/100,commissioneEuro:chosen.reduce((s,r)=>s+r.commissionCents,0)/100,km:Math.round(chosen.reduce((s,r)=>s+r.km,0)*100)/100,concatenati:chosen.filter(r=>r.missions>1).length}}
let milp=null;
if(process.env.TURENTU_TEST23_SKIP_MILP!=='1'){
 const args={input:JSON.stringify({rows}),encoding:'utf8',timeout:40000,maxBuffer:1024*1024};
 const custom=process.env.TURENTU_PYTHON;
 let p=spawnSync(custom||'py',custom?['-c',PY]:['-3','-c',PY],args);
 if(p.error?.code==='ENOENT'&&!custom)p=spawnSync('python',['-c',PY],args);
 if(p.status!==0)throw Error('MILP non disponibile: '+(p.stderr||p.error?.message||p.status));
 milp=JSON.parse(p.stdout);milp.metriche=metrics(milp.selected);
}

// TEST 24: Scenari avversari costruiti ESCLUSIVAMENTE da cicli reali validati dall'adapter.
// Gli incentivi sintetici sono punteggi di prova e NON modificano il margine economico POPBUS.
const actualRows=rows;
const actualAdj=adj;
const actualMetrics=metrics;
const scenarios=[];
const failures=[];
const check=(name,pass)=>{const c={name,pass:Boolean(pass)};if(!c.pass)failures.push(name);return c};
const asCents=r=>r.cents;
const concat2=actualRows.findIndex(r=>r.missions===2);
const concat3=actualRows.findIndex(r=>r.missions===3);
if(concat2<0||concat3<0)throw Error('Non sono disponibili cicli concatenati da 2 e 3 missioni');
function objective(ids,score){return ids.reduce((s,i)=>s+score[i],0)}
function valid(ids){
 const selected=new Set(ids);if(selected.size!==ids.length)return false;
 for(const i of ids){if(i<0||i>=actualRows.length)return false;for(const j of actualAdj[i])if(selected.has(j))return false}
 return true;
}
function exactMILP(score,indices){
 const map=indices.map(i=>actualRows[i]);
 const payload={rows:map.map((r,k)=>({...r,cents:score[indices[k]]}))};
 const custom=process.env.TURENTU_PYTHON;
 const args={input:JSON.stringify(payload),encoding:'utf8',timeout:40000,maxBuffer:1024*1024};
 let p=spawnSync(custom||'py',custom?['-c',PY]:['-3','-c',PY],args);
 if(p.error?.code==='ENOENT'&&!custom)p=spawnSync('python',['-c',PY],args);
 if(p.status!==0)throw Error('MILP Test24 non disponibile: '+(p.stderr||p.error?.message||p.status));
 const res=JSON.parse(p.stdout);
 return {...res,selected:res.selected.map(k=>indices[k])};
}
function greedyScore(score,indices){
 const order=[...indices].sort((a,b)=>score[b]-score[a]||a-b),picked=[];
 for(const i of order)if(picked.every(j=>!actualAdj[i].has(j)))picked.push(i);
 return picked;
}
function localScore(score,indices,initial){
 const order=[...indices].sort((a,b)=>score[b]-score[a]||a-b),all=new Set(indices);
 let picked=[...initial],moves=[],evals=0,stop=null;
 const start=clock();
 for(let pass=0;pass<maxPasses;pass++){
  if(clock()-start>=limitMs){stop='budget_tempo';break}
  const taken=new Set(picked),out=order.filter(i=>!taken.has(i));
  const blockers=new Map(out.map(i=>[i,[...actualAdj[i]].filter(j=>taken.has(j))]));
  let best=null,bestGain=0;
  function consider(remove,add,type){
   if(evals>=maxEvaluations||clock()-start>=limitMs){stop=evals>=maxEvaluations?'budget_valutazioni':'budget_tempo';return false}
   evals++;
   const gain=objective(add,score)-objective(remove,score);
   if(gain<=bestGain||add.length===2&&actualAdj[add[0]].has(add[1]))return true;
   const removed=new Set(remove);
   if(add.some(i=>[...actualAdj[i]].some(j=>taken.has(j)&&!removed.has(j))))return true;
   best={remove,add,type,gain};bestGain=gain;return true;
  }
  for(const i of out){const b=blockers.get(i);if(b.length<=2&&!consider(b,[i],`${b.length}->1`))break}
  if(stop)break;
  for(const r of picked){
   const eligible=out.filter(i=>blockers.get(i).every(j=>j===r)).slice(0,24);
   for(let a=0;a<eligible.length;a++){
    for(let b=a+1;b<eligible.length;b++)if(!consider([r],[eligible[a],eligible[b]],'1->2'))break;
    if(stop)break;
   }if(stop)break;
  }
  if(stop||!best)break;
  const removed=new Set(best.remove);
  picked=[...picked.filter(i=>!removed.has(i)),...best.add];
  if(!valid(picked)||picked.some(i=>!all.has(i)))throw Error('Mossa locale non valida');
  moves.push({tipo:best.type,deltaScoreEuro:best.gain/100,escono:best.remove,entrano:best.add});
  if(pass===maxPasses-1)stop='limite_passate';
 }
 return {selected:picked,moves,evaluations:evals,stop,ms:+(clock()-start).toFixed(2)};
}
function buildScenario(name,anchor,synthetic){
 // Include tutti i candidati che condividono richieste o veicolo con l'ancora, e una selezione
 // di indipendenti. Un universo ristretto rende la certificazione MILP riproducibile.
 const neighbors=[...actualAdj[anchor]].sort((a,b)=>actualRows[b].cents-actualRows[a].cents).slice(0,28);
 const independent=actualRows.map((_,i)=>i).filter(i=>i!==anchor&&!actualAdj[anchor].has(i)).slice(0,8);
 const indices=[...new Set([anchor,...neighbors,...independent])];
 const score=actualRows.map(asCents);
 if(synthetic){
  // Dominanza deliberata del concatenato: il punteggio supera il valore di tutti gli altri
  // candidati del sottoproblema; si tratta di un test di scelta, NON di un prezzo reale.
  score[anchor]=indices.reduce((s,i)=>s+Math.max(0,score[i]),0)+100;
 }
 const greedy=greedyScore(score,indices);
 const improved=localScore(score,indices,greedy);
 const exact=exactMILP(score,indices);
 const checks=[
  check('Ciclo ancora validato da adapter',actualRows[anchor].missions>1),
  check('Greedy privo di conflitti',valid(greedy)),
  check('Locale priva di conflitti',valid(improved.selected)),
  check('MILP certificato',exact.certified&&exact.gap===0),
  check('MILP privo di conflitti',valid(exact.selected)),
  check('Locale non peggiora greedy',objective(improved.selected,score)>=objective(greedy,score)),
  check('Locale non supera MILP',objective(improved.selected,score)<=objective(exact.selected,score)),
  check('MILP seleziona concatenato dominante',!synthetic||exact.selected.includes(anchor)),
  check('Locale seleziona concatenato dominante',!synthetic||improved.selected.includes(anchor))
 ];
 return {name,modalitaPunteggio:synthetic?'SINTETICO — non e un margine reale':'REALE — margine adapter',candidate:indices.length,ancora:{indice:anchor,missioni:actualRows[anchor].missions,richieste:actualRows[anchor].reqIds.length,margineRealeEuro:actualRows[anchor].cents/100},greedy:{scoreEuro:objective(greedy,score)/100,margineRealeEuro:objective(greedy,actualRows.map(asCents))/100,concatenati:greedy.filter(i=>actualRows[i].missions>1).length,ancoraSelezionata:greedy.includes(anchor)},indicizzata:{scoreEuro:objective(improved.selected,score)/100,margineRealeEuro:objective(improved.selected,actualRows.map(asCents))/100,concatenati:improved.selected.filter(i=>actualRows[i].missions>1).length,ancoraSelezionata:improved.selected.includes(anchor),...{mosse:improved.moves,mosseValutate:improved.evaluations,stopBudget:improved.stop,tempoMs:improved.ms}},milp:{scoreEuro:objective(exact.selected,score)/100,margineRealeEuro:objective(exact.selected,actualRows.map(asCents))/100,concatenati:exact.selected.filter(i=>actualRows[i].missions>1).length,ancoraSelezionata:exact.selected.includes(anchor),certified:exact.certified,gap:exact.gap,solverMs:exact.solverMs},checks};
}
scenarios.push(buildScenario('CONCATENAZIONE_2_MISSIONI_DOMINANTE',concat2,true));
scenarios.push(buildScenario('CONCATENAZIONE_3_MISSIONI_DOMINANTE',concat3,true));
scenarios.push(buildScenario('CONCATENAZIONE_2_MISSIONI_ECONOMIA_REALE',concat2,false));
scenarios.push(buildScenario('CONCATENAZIONE_3_MISSIONI_ECONOMIA_REALE',concat3,false));
const allChecks=scenarios.flatMap(s=>s.checks);
const report={test:'TURENTU TEST 24 — OTTIMIZZAZIONE MISTA AVVERSARIA',modalita:'SOLA LETTURA; cicli PIXEL/POPBUS validati; scenari economici reali e sintetici distinti',limiti:['Routing sintetico; non usa worker o database','Scenari dominanti usano punteggi sintetici per forzare la scelta; non rappresentano profitti reali','MILP certifica solo i sottoinsiemi di candidate generati','Non verifica trasferimenti fra cicli distinti sullo stesso veicolo','Ricerca locale puo fermarsi su ottimi locali; il MILP resta il riferimento'],dataset:{richieste:requests.length,veicoli:vehicles.length,cicliValidi:actualRows.length,concatenati2:actualRows.filter(r=>r.missions===2).length,concatenati3:actualRows.filter(r=>r.missions===3).length},scenari:scenarios,passed:allChecks.filter(c=>c.pass).length,failed:failures.length};
console.log(JSON.stringify(report,null,2));
if(failures.length)process.exitCode=1;
