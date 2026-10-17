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
  km:result.economia.km.totali,validated:result.validazionePreliminare,attivabile:result.attivabile,
  startNode:byId.get(p[0].requestIds[0])?.start_node_id,
  endNode:byId.get(p[p.length-1].requestIds.at(-1))?.end_node_id});
}
const diagnosisMs=performance.now()-t0;




// TEST 25 — stress operativo sintetico con cicli reali validati da adapter.
// NON modifica database o worker. I cicli base sono validati dall'adapter;
// la replica temporale e' una simulazione, NON viene rivalidata dall'adapter.
import {spawnSync} from 'node:child_process';
const clock=()=>performance.now();
const envInt=(name,fallback)=>{const x=Number(process.env[name]);return Number.isFinite(x)&&x>0?Math.floor(x):fallback};
const bufferMin=envInt('TURENTU_TEST25_BUFFER_MIN',3);
const travelMs=(a,b)=>Math.abs(Number(a)-Number(b))*120000;
const baseRows=checked.filter(r=>r.cents>0&&Number.isFinite(r.busyStart)&&Number.isFinite(r.busyEnd)&&r.busyEnd>r.busyStart&&Number.isFinite(r.startNode)&&Number.isFinite(r.endNode));
if(!baseRows.some(r=>r.missions===2)||!baseRows.some(r=>r.missions===3))throw Error('Dataset base privo di concatenazioni validate');
// Repliche di finestre operative: IDs richiesta/veicolo distinti tra finestre;
// i proprietari possiedono due veicoli. Alcune finestre si sovrappongono.
function buildRows(target){
 const arr=[];const shiftMinutes=55;
 for(let k=0;arr.length<target;k++){
  const original=baseRows[k%baseRows.length];const wave=Math.floor(k/baseRows.length);
  const shift=wave*shiftMinutes*60000;
  const vehicleGroup=wave%3;
  arr.push({...original,id:`rep${wave}:${original.id}`,vehicleId:`${vehicleGroup}:${original.vehicleId}`,
   ownerId:`fleet:${vehicleGroup}:${original.ownerId}`,
   reqIds:original.reqIds.map(q=>`${wave}:${q}`),busyStart:original.busyStart+shift,busyEnd:original.busyEnd+shift,
   simulatedReplica:wave>0});
 }
 return arr;
}
function conflict(a,b){
 if(a.reqIds.some(q=>b.reqIds.includes(q)))return 'richiesta';
 if(a.vehicleId!==b.vehicleId)return null;
 if(a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd)return 'occupazione';
 const first=a.busyStart<=b.busyStart?a:b,second=first===a?b:a;
 // Vincolo piu' rigoroso: dopo il busyEnd il veicolo deve raggiungere
 // il punto iniziale del ciclo seguente, con buffer operativo.
 if(first.busyEnd+travelMs(first.endNode,second.startNode)+bufferMin*60000>second.busyStart)return 'trasferimento';
 return null;
}
function graph(rows){
 const t=clock(),adj=Array.from({length:rows.length},()=>new Set()),byReq=new Map(),byVehicle=new Map();
 const add=(i,j)=>{if(i===j)return;adj[i].add(j);adj[j].add(i)};
 for(let i=0;i<rows.length;i++){
  for(const q of rows[i].reqIds){if(!byReq.has(q))byReq.set(q,[]);byReq.get(q).push(i)}
  const v=rows[i].vehicleId;if(!byVehicle.has(v))byVehicle.set(v,[]);byVehicle.get(v).push(i);
 }
 for(const ids of byReq.values())for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)add(ids[i],ids[j]);
 for(const ids of byVehicle.values())for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)if(conflict(rows[ids[i]],rows[ids[j]]))add(ids[i],ids[j]);
 let edges=0;for(const s of adj)edges+=s.size;
 return {adj,edges:edges/2,ms:clock()-t};
}
function valid(ids,rows,adj){
 const set=new Set(ids);return set.size===ids.length&&ids.every(i=>i>=0&&i<rows.length&&![...adj[i]].some(j=>set.has(j)));
}
function objective(ids,rows){return ids.reduce((sum,i)=>sum+rows[i].cents,0)}
function optimize(rows,adj){
 const order=rows.map((_,i)=>i).sort((a,b)=>rows[b].cents-rows[a].cents||a-b);
 const greedy=[];for(const i of order)if(greedy.every(j=>!adj[i].has(j)))greedy.push(i);
 const maxMs=envInt('TURENTU_TEST25_LOCAL_MS',500),maxPass=envInt('TURENTU_TEST25_PASSES',20),maxEval=envInt('TURENTU_TEST25_EVAL',100000);
 let selected=[...greedy],evals=0,stop=null,moves=[];const t=clock();
 for(let pass=0;pass<maxPass;pass++){
  if(clock()-t>=maxMs){stop='budget_tempo';break}
  const taken=new Set(selected),outside=order.filter(i=>!taken.has(i)),block=new Map(outside.map(i=>[i,[...adj[i]].filter(j=>taken.has(j))]));
  let best=null,gain=0;
  function consider(remove,add){
   if(evals>=maxEval||clock()-t>=maxMs){stop=evals>=maxEval?'budget_valutazioni':'budget_tempo';return}
   evals++;
   const d=objective(add,rows)-objective(remove,rows);
   if(d<=gain||add.length===2&&adj[add[0]].has(add[1]))return;
   const gone=new Set(remove);
   if(add.some(i=>[...adj[i]].some(j=>taken.has(j)&&!gone.has(j))))return;
   best={remove,add,gain:d};gain=d;
  }
  for(const i of outside){if(block.get(i).length<=2)consider(block.get(i),[i]);if(stop)break}
  if(stop)break;
  for(const r of selected){
   const eligible=outside.filter(i=>block.get(i).every(j=>j===r)).slice(0,24);
   for(let a=0;a<eligible.length;a++)for(let b=a+1;b<eligible.length;b++){
    consider([r],[eligible[a],eligible[b]]);if(stop)break;
   }
   if(stop)break;
  }
  if(stop||!best)break;
  const gone=new Set(best.remove);selected=[...selected.filter(i=>!gone.has(i)),...best.add];
  if(!valid(selected,rows,adj))throw Error('Ottimizzazione produce conflitti');
  moves.push(best.gain/100);
  if(pass===maxPass-1)stop='limite_passate';
 }
 return {greedy,selected,evals,stop,moves,ms:clock()-t};
}
function stats(ids,rows){const chosen=ids.map(i=>rows[i]);return {cicli:chosen.length,missioni:chosen.reduce((s,r)=>s+r.missions,0),richieste:new Set(chosen.flatMap(r=>r.reqIds)).size,concatenati:chosen.filter(r=>r.missions>1).length,margineEuro:+(objective(ids,rows)/100).toFixed(2),commissioneEuro:+(chosen.reduce((s,r)=>s+r.commissionCents,0)/100).toFixed(2),km:+chosen.reduce((s,r)=>s+r.km,0).toFixed(2)}}
const PY=String.raw`import sys,json,time
import numpy as np
from scipy.optimize import milp,Bounds,LinearConstraint
from scipy.sparse import lil_matrix
p=json.load(sys.stdin);n=len(p['cents']);e=p['edges'];a=lil_matrix((len(e),n),dtype=float)
for k,(i,j) in enumerate(e):a[k,i]=1;a[k,j]=1
s=time.perf_counter()
r=milp(c=-np.array(p['cents'],dtype=float),integrality=np.ones(n),bounds=Bounds(np.zeros(n),np.ones(n)),constraints=LinearConstraint(a.tocsr(),0,1),options={'time_limit':20,'mip_rel_gap':0.0})
print(json.dumps({'status':int(r.status),'certified':bool(r.status==0),'gap':float(r.mip_gap) if getattr(r,'mip_gap',None) is not None else None,'selected':[i for i,x in enumerate(r.x) if x>0.5] if r.x is not None else [],'solverMs':round((time.perf_counter()-s)*1000,2)}))`;
function milpSmall(rows,adj){
 const edges=[];for(let i=0;i<rows.length;i++)for(const j of adj[i])if(j>i)edges.push([i,j]);
 const args={input:JSON.stringify({cents:rows.map(r=>r.cents),edges}),encoding:'utf8',timeout:40000,maxBuffer:2*1024*1024};
 const custom=process.env.TURENTU_PYTHON;
 let p=spawnSync(custom||'py',custom?['-c',PY]:['-3','-c',PY],args);
 if(p.error?.code==='ENOENT'&&!custom)p=spawnSync('python',['-c',PY],args);
 if(p.status!==0)throw Error('MILP non disponibile: '+(p.stderr||p.error?.message||p.status));
 return JSON.parse(p.stdout);
}
const scenarios=[],checks=[];const test=(name,pass)=>checks.push({name,pass:Boolean(pass)});
for(const size of [120,300,600]){
 const rows=buildRows(size),g=graph(rows),opt=optimize(rows,g.adj);
 let independent=true;
 for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)if(g.adj[i].has(j)!==Boolean(conflict(rows[i],rows[j])))independent=false;
 let kinds={richiesta:0,occupazione:0,trasferimento:0};
 for(let i=0;i<rows.length;i++)for(const j of g.adj[i])if(j>i){const k=conflict(rows[i],rows[j]);if(k)kinds[k]++}
 const s={candidate:size,richiesteDistinte:new Set(rows.flatMap(r=>r.reqIds)).size,veicoliDistinti:new Set(rows.map(r=>r.vehicleId)).size,flotteDistinte:new Set(rows.map(r=>r.ownerId)).size,concatenatiCandidati:rows.filter(r=>r.missions>1).length,archiConflitto:g.edges,tipiConflitto:kinds,tempiMs:{indice:+g.ms.toFixed(2),ottimizzazione:+opt.ms.toFixed(2)},greedy:stats(opt.greedy,rows),indicizzata:{...stats(opt.selected,rows),mosse:opt.moves.length,mosseValutate:opt.evals,stopBudget:opt.stop},milp:null};
 const prefix=`${size} candidate`;
 test(prefix+' indice coincide con validatore indipendente',independent);
 test(prefix+' greedy senza conflitti',valid(opt.greedy,rows,g.adj));
 test(prefix+' indicizzata senza conflitti',valid(opt.selected,rows,g.adj));
 test(prefix+' margine indicizzata non peggiora',objective(opt.selected,rows)>=objective(opt.greedy,rows));
 test(prefix+' proprietari multi-veicolo',new Set(rows.map(r=>r.ownerId)).size<new Set(rows.map(r=>r.vehicleId)).size);
 test(prefix+' concatenazioni disponibili',s.concatenatiCandidati>0);
 test(prefix+' nessuna anomalia economica',rows.every(r=>Number.isInteger(r.cents)&&r.cents>0&&Number.isFinite(r.km)));
 test(prefix+' vincoli temporali validi',rows.every(r=>r.busyEnd>r.busyStart));
 if(size===120&&process.env.TURENTU_TEST25_SKIP_MILP!=='1'){
  const m=milpSmall(rows,g.adj);s.milp={...m,metriche:stats(m.selected,rows)};
  test(prefix+' MILP certificato',m.certified&&m.gap===0);
  test(prefix+' MILP senza conflitti',valid(m.selected,rows,g.adj));
  test(prefix+' indicizzata non supera MILP',objective(opt.selected,rows)<=objective(m.selected,rows));
 }
 scenarios.push(s);
}
const report={test:'TURENTU TEST 25 — STRESS OPERATIVO MISTO',modalita:'SOLA LETTURA; cicli base PIXEL/POPBUS/adapter; repliche temporali sintetiche; vincolo di trasferimento esterno sperimentale',limiti:['Nessun worker o database; routing e disponibilita sintetici','Solo i cicli base sono validati dall adapter; le repliche sono sintetiche','Origine/fine del ciclo derivate dalle richieste estreme, non dalla traiettoria effettiva del veicolo: il controllo trasferimento e un proxy conservativo, NON una certificazione fisica','Il ritorno alla base e incluso nei margini/busy del ciclo base secondo adapter; non e rivalidato nelle repliche','MILP solo su 120 candidate e ottimizza esclusivamente le candidate generate','L ottimizzazione indicizzata e una versione sperimentale inclusa nel test, non il worker produttivo'],datasetBase:{richieste:requests.length,veicoli:vehicles.length,cicliValidi:baseRows.length,concatenati2:baseRows.filter(r=>r.missions===2).length,concatenati3:baseRows.filter(r=>r.missions===3).length,rifiuti:rejected,adapterMs:+diagnosisMs.toFixed(2)},scenari:scenarios,checks,passed:checks.filter(c=>c.pass).length,failed:checks.filter(c=>!c.pass).length};
console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
