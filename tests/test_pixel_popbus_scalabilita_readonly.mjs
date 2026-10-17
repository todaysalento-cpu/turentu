// TURENTU TEST 15 — Benchmark di scalabilita PIXEL / POPBUS / adapter / MILP
// SOLA LETTURA. Non importa DB o worker, non scrive dati. Routing sintetico.
// Eseguire: node tests/test_pixel_popbus_scalabilita_readonly.mjs
// Opzioni: TURENTU_TEST15_SIZES=100,500,1000 | TURENTU_TEST15_SOLVER_SEC=12
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {createIncrementalCorridorEngine} from '../services/pixel/incremental-corridor-engine.js';
import {diagnosticaCicloPixelPopbus} from '../services/pixel/pixel-popbus-cycle-adapter.js';
import {generaCandidate,valutaRichieste} from '../services/popbus/v2/model.js';

const BASE=Date.parse('2030-04-01T10:00:00Z');
const iso=m=>new Date(BASE+m*60000).toISOString();
const round=(x,n=2)=>+Number(x).toFixed(n);
const ms=()=>performance.now();
const LIMIT_SEC=Math.max(2,Math.min(60,Number(process.env.TURENTU_TEST15_SOLVER_SEC||12)));
const sizes=(process.env.TURENTU_TEST15_SIZES||'100,500,1000').split(',').map(Number).filter(x=>Number.isInteger(x)&&x>=3&&x<=3000);
if(!sizes.length)throw Error('TURENTU_TEST15_SIZES deve contenere numeri interi da 3 a 3000');
const PY=String.raw`import json,sys,time
import numpy as np
from scipy.optimize import milp,Bounds,LinearConstraint
from scipy.sparse import lil_matrix
p=json.load(sys.stdin); rows=p['rows']; n=len(rows); t=time.perf_counter()
if not n:
 print(json.dumps({'status':'EMPTY','certified':False,'selected':[],'constraints':0,'solverMs':0}));sys.exit(0)
cons=[];byreq={};byvehicle={}
for i,r in enumerate(rows):
 for q in r['reqIds']:byreq.setdefault(q,[]).append(i)
 byvehicle.setdefault(str(r['vehicleId']),[]).append(i)
for ids in byreq.values():cons.append(ids)
for ids in byvehicle.values():
 for ai,i in enumerate(ids):
  a=rows[i]
  for j in ids[ai+1:]:
   b=rows[j]
   if a['busyStart']<b['busyEnd'] and b['busyStart']<a['busyEnd']:cons.append([i,j])
A=lil_matrix((len(cons),n),dtype=np.float64)
for k,ids in enumerate(cons):A[k,ids]=1
r=milp(c=-np.array([x['cents'] for x in rows],dtype=float),integrality=np.ones(n),bounds=Bounds(np.zeros(n),np.ones(n)),constraints=[LinearConstraint(A.tocsr(),0,1)],options={'time_limit':float(p['limitSec']),'mip_rel_gap':0.0})
selected=[i for i,x in enumerate(r.x) if x>.5] if r.x is not None else []
print(json.dumps({'status':int(r.status),'certified':bool(r.status==0),'selected':selected,'constraints':len(cons),'solverMs':round((time.perf_counter()-t)*1000,2),'gap':float(r.mip_gap) if getattr(r,'mip_gap',None) is not None else None,'message':str(r.message)[:200]}))`;
function solve(rows){
 const args={input:JSON.stringify({rows,limitSec:LIMIT_SEC}),encoding:'utf8',maxBuffer:32*1024*1024,timeout:(LIMIT_SEC+45)*1000};
 const configured=process.env.TURENTU_PYTHON;
 let p=spawnSync(configured||'py',configured?['-c',PY]:['-3','-c',PY],args);
 if(p.error?.code==='ENOENT'&&!configured)p=spawnSync('python',['-c',PY],args);
 if(p.status!==0) return {error:(p.stderr||p.error?.message||p.stdout||'exit '+p.status).slice(0,400),certified:false,selected:[]};
 try{return JSON.parse(p.stdout)}catch{return {error:'JSON solver non valido',certified:false,selected:[]}}
}
const overlap=(a,b)=>a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd;
function greedy(rows){
 const sorted=[...rows.keys()].sort((a,b)=>rows[b].cents-rows[a].cents||a-b),out=[],used=new Set(),byvehicle=new Map();
 for(const i of sorted){const r=rows[i];if(r.cents<=0||r.reqIds.some(q=>used.has(q)))continue;
 if((byvehicle.get(r.vehicleId)||[]).some(other=>overlap(r,other)))continue;
 out.push(i);r.reqIds.forEach(q=>used.add(q));if(!byvehicle.has(r.vehicleId))byvehicle.set(r.vehicleId,[]);byvehicle.get(r.vehicleId).push(r);
 }return out;
}
function metrics(rows,ids){const a=ids.map(i=>rows[i]);return {cicli:a.length,richiesteServite:new Set(a.flatMap(x=>x.reqIds)).size,margineEuro:round(a.reduce((s,x)=>s+x.cents,0)/100),commissioneEuro:round(a.reduce((s,x)=>s+x.commissionCents,0)/100),km:round(a.reduce((s,x)=>s+x.km,0))}}
function validate(rows,ids){const used=new Set(),byVehicle=new Map();for(const i of ids){if(!Number.isInteger(i)||i<0||i>=rows.length)return false;const r=rows[i];for(const q of r.reqIds){if(used.has(q))return false;used.add(q)}for(const a of byVehicle.get(r.vehicleId)||[])if(overlap(a,r))return false;if(!byVehicle.has(r.vehicleId))byVehicle.set(r.vehicleId,[]);byVehicle.get(r.vehicleId).push(r)}return true}
async function scenario(n,vcount){
 const t0=ms(),nodes=[],requests=[];
 // Zone indipendenti, tre richieste concatenate per zona, tempi separati.
 for(let j=0;j<n;j++){
  const g=Math.floor(j/3),p=j%3,ids=[g*10+1,g*10+2,g*10+3,g*10+4];
  if(p===0)for(const id of ids)nodes.push({id,lat:40,lon:18+id*0.001});
  requests.push({id:j+1,start_node_id:ids[p],end_node_id:ids[p+1],origine_nodo_territoriale_id:ids[p],destinazione_nodo_territoriale_id:ids[p+1],start_datetime:iso(g*32+p*11),posti_richiesti:1+(j%2),prezzo:50+(j%4)*15,classe:'STANDARD',classe_percorrenza:'BASSA',max_fermate_intermedie:10,min_km_tra_fermate:0,max_deviazione_pct:100});
 }
 const byId=new Map(requests.map(r=>[r.id,r])),byNode=new Map(nodes.map(x=>[x.id,x]));
 const leg=(a,b)=>({metres:Math.abs(Number(b)-Number(a))*2000,seconds:Math.abs(Number(b)-Number(a))*120,polyline:`mock-${a}-${b}`});
 const routeNodes=async ids=>({verificataRouting:true,legs:ids.slice(1).map((id,i)=>leg(ids[i],id))});
 const road=async(a,b)=>leg(Math.round((a.lon-18)/.001),Math.round((b.lon-18)/.001));
 const engine=createIncrementalCorridorEngine({routeNodes,abilitaVariantiP1:true,maxVariantiPerRichiesta:4,maxNodiVariante:6,tolleranzaMinuti:30});
 const tPixel=ms();for(const r of requests)await engine.processRequest(r);const corridors=engine.listCorridors();const pixelMs=ms()-tPixel;
 const tPop=ms();let popbusCount=null,popbusError=null;
 try{popbusCount=generaCandidate(requests,Math.max(10000,n*30)).length}catch(e){popbusError=String(e.message).slice(0,200)}
 const popbusMs=ms()-tPop;
 const tPlan=ms(),missionRows=[],seen=new Set();
 for(const c of corridors){for(const group of engine.temporalCandidatesComplete(c.id)){
  const ids=[...group.richiestaIds].map(Number).sort((a,b)=>a-b);if(!ids.length||ids.length>3)continue;
  const key=`${c.id}:${ids.join(',')}`;if(seen.has(key))continue;seen.add(key);
  const selected=ids.map(id=>byId.get(id));if(selected.some(x=>!x))continue;
  try{const ev=valutaRichieste({nodes:c.nodes,legs:c.legs},selected,ids,{mode:'seeds_only',maxPeak:8});if(ev?.requests?.length!==ids.length)continue;
   const g=Math.floor((Number(c.nodes[0])-1)/10);if(c.nodes.some(x=>Math.floor((Number(x)-1)/10)!==g))continue;
   missionRows.push({corridorId:c.id,requestIds:ids,departure:ev.departure,group:g});
  }catch{}
 }}
 const ordered=missionRows.sort((a,b)=>a.departure-b.departure||String(a.corridorId).localeCompare(String(b.corridorId)));
 const seeds=new Map();for(const m of ordered)if(!seeds.has(m.group))seeds.set(m.group,m);
 const seedRows=[...seeds.values()].sort((a,b)=>a.group-b.group),plans=[];
 // Crea cicli da 1/2/3 missioni, senza enumerare tutto il prodotto cartesiano.
 for(let i=0;i<seedRows.length;i++)for(let k=1;k<=3&&i+k<=seedRows.length;k++){
  const seq=seedRows.slice(i,i+k);if(seq.some((m,j)=>j&&m.group!==seq[j-1].group+1))continue;
  plans.push(seq.map(m=>({corridorId:m.corridorId,requestIds:m.requestIds})));
 }
 const cap={100:300,500:650,1000:1100}[n]||Math.min(1500,n*2);
 for(const m of ordered.slice(0,Math.min(120,ordered.length)))plans.push([{corridorId:m.corridorId,requestIds:m.requestIds}]);
 const key=p=>p.map(m=>`${m.corridorId}:${m.requestIds.join(',')}`).join('|');
 const unique=[...new Map(plans.map(p=>[key(p),p])).values()];
 const vehicles=[];for(let i=0;i<vcount;i++){
  const node=nodes[Math.floor(i*nodes.length/vcount)];vehicles.push({id:2000+i,driver_id:700+Math.floor(i/2),posti_totali:6+(i%2),euro_km:[.45,.6,.8][i%3],lat:node.lat,lon:node.lon});
 }
 const planningMs=ms()-tPlan;
 const tAdapter=ms(),checked=[],rejected={};let evaluated=0,attempts=0;
 // Budget fisso e dichiarato: misura throughput, NON valutazione esaustiva.
 const pairs=[];for(let pi=0;pi<unique.length;pi++){
  const p=unique[pi];const g=Math.floor((Number(engine.getCorridor(p[0].corridorId).nodes[0])-1)/10);
  const nearby=[...vehicles].sort((a,b)=>Math.abs(a.lon-(18+(g*10+1)*.001))-Math.abs(b.lon-(18+(g*10+1)*.001)));
  for(const v of nearby.slice(0,Math.min(4,vcount)))pairs.push([p,v]);
 }
 // Campione distribuito su tutta la lista, fino al limite di valutazioni.
 const selectedPairs=pairs.length<=cap?pairs:Array.from({length:cap},(_,i)=>pairs[Math.floor(i*pairs.length/cap)]);
 for(const [p,v] of selectedPairs){attempts++;
  try{const result=await diagnosticaCicloPixelPopbus({engine,missioni:p,richieste:requests,vehicle:v,nodes,road,now:Date.parse('2029-01-01T00:00:00Z'),maxWaitMin:180,costoAttesaOraEuro:2,validateVehicle:async()=>true,validateCandidate:async()=>true});
   evaluated++;if(!result.ok){rejected[result.motivo]=(rejected[result.motivo]||0)+1;continue}
   const cents=result.economia?.centesimi?.margine;if(!Number.isInteger(cents))throw Error('Margine non intero');
   checked.push({vehicleId:v.id,reqIds:result.richieste.map(String),busyStart:result.busyStart,busyEnd:result.busyEnd,cents,commissionCents:result.economia.centesimi.commissione,km:result.economia.km.totali});
  }catch(e){rejected['ERRORE_TEST:'+String(e.message).slice(0,80)]=(rejected['ERRORE_TEST:'+String(e.message).slice(0,80)]||0)+1}
 }
 const adapterMs=ms()-tAdapter;
 const tGreedy=ms(),g=greedy(checked),greedyMs=ms()-tGreedy;
 const tSolver=ms(),solver=solve(checked),solverWallMs=ms()-tSolver;
 const sel=solver.selected||[],gm=metrics(checked,g),mm=metrics(checked,sel);
 const checks=[{name:'Corridoi PIXEL prodotti',pass:corridors.length>0},{name:'Candidate POPBUS prodotte',pass:popbusCount>0},{name:'Cicli adapter validi',pass:checked.length>0},{name:'Greedy senza conflitti',pass:validate(checked,g)},{name:'MILP senza conflitti se disponibile',pass:!sel.length||validate(checked,sel)},{name:'MILP non peggiore della greedy se certificato',pass:!solver.certified||mm.margineEuro+0.01>=gm.margineEuro}];
 return {dimensione:{richieste:n,veicoli:vcount},dataset:{corridoiPixel:corridors.length,candidatePopbus:popbusCount,missioniPixel:missionRows.length,piani:unique.length,coppiePianoVeicoloPossibili:pairs.length,coppieValutate:attempts,campioneLimitato:attempts<pairs.length,cicliValidi:checked.length,rifiuti:rejected},tempiMs:{pixel:round(pixelMs),popbus:round(popbusMs),costruzionePiani:round(planningMs),adapter:round(adapterMs),greedy:round(greedyMs),solverWall:round(solverWallMs),totale:round(ms()-t0)},throughputAdapterValutazioniSec:round(evaluated/(adapterMs/1000)),heapUsedMB:round(process.memoryUsage().heapUsed/1048576),greedy:gm,milp:{...mm,certificatoOttimo:!!solver.certified,status:solver.status??null,gap:solver.gap??null,vincoli:solver.constraints??null,solverMs:solver.solverMs??null,errore:solver.error??null,messaggio:solver.message??null},deltaMargineEuro:round(mm.margineEuro-gm.margineEuro),checks,passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass).length};
}
const output={test:'TURENTU TEST 15 — SCALABILITA PIXEL POPBUS MILP',modalita:'SOLA LETTURA; moduli reali; routing e dati sintetici; MILP SciPy HiGHS',avvertenze:[
 'Le dimensioni 100/500/1000 si riferiscono alle richieste elaborate integralmente da PIXEL e POPBUS; le valutazioni adapter sono CAMPIONATE e limitate per tempo.',
 'Il MILP ottimizza SOLO i cicli campionati e validati, non tutte le combinazioni possibili. Il gap=0 certifica solo quel sottoproblema.',
 'Il benchmark non e un test di carico HTTP, database, worker, rete, routing stradale o produzione.',
 'Tempi wall-clock, hardware e versioni moduli influenzano i risultati; nessuna garanzia SLA.',
 'Le missioni PIXEL sono generate da dati sintetici in zone indipendenti, non da traffico reale.',
 'POPBUS genera candidate di controllo, non alimenta il MILP. Greedy sperimentale, non selettore produttivo.'
],scenari:[],errors:[]};
for(const n of sizes){const v=n<=100?20:n<=500?50:100;try{output.scenari.push(await scenario(n,v))}catch(e){output.errors.push({richieste:n,errore:String(e.stack||e).slice(0,1200)})}}
output.passed=output.scenari.reduce((s,x)=>s+x.passed,0);output.failed=output.scenari.reduce((s,x)=>s+x.failed,0)+output.errors.length;
console.log(JSON.stringify(output,null,2));if(output.failed)process.exitCode=1;
