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

// TEST 11 — MIP HiGHS (SciPy) senza modifiche ai moduli di produzione.
import {spawnSync} from 'node:child_process';
const PYTHON=String.raw`import json,sys,time
import numpy as np
from scipy.optimize import milp,Bounds,LinearConstraint
from scipy.sparse import lil_matrix
payload=json.load(sys.stdin)
rows=payload['rows']; n=len(rows)
req={r:i for i,r in enumerate(sorted({q for x in rows for q in x['reqIds']}))}
constraints=[]
for q in req:
 ids=[i for i,x in enumerate(rows) if q in x['reqIds']]
 if ids:constraints.append(ids)
# Each same-vehicle overlapping interval pair: independent of ownerId.
for i,a in enumerate(rows):
 for j in range(i+1,n):
  b=rows[j]
  if a['vehicleId']==b['vehicleId'] and a['busyStart']<b['busyEnd'] and b['busyStart']<a['busyEnd']:
   constraints.append([i,j])
A=lil_matrix((len(constraints),n),dtype=np.float64)
for k,ids in enumerate(constraints):A[k,ids]=1.0
A=A.tocsr()
base=LinearConstraint(A,np.zeros(len(constraints)),np.ones(len(constraints)))
margin=np.array([x['cents'] for x in rows],dtype=np.float64)
coverage=np.array([len(x['reqIds']) for x in rows],dtype=np.float64)
commission=np.array([x['commissionCents'] for x in rows],dtype=np.float64)
limit=float(payload.get('limitSeconds',20))
def solve(obj, extra=[]):
 t=time.perf_counter()
 res=milp(c=-obj,integrality=np.ones(n),bounds=Bounds(np.zeros(n),np.ones(n)),constraints=[base,*extra],options={'time_limit':limit,'mip_rel_gap':0.0})
 selected=[i for i,v in enumerate(res.x) if v>0.5] if res.x is not None else []
 return {'indices':selected,'status':int(res.status),'message':str(res.message),'certified':bool(res.status==0),'nodes':int(getattr(res,'mip_node_count',0) or 0),'gap':float(res.mip_gap) if getattr(res,'mip_gap',None) is not None else None,'dualBound':float(-res.mip_dual_bound) if getattr(res,'mip_dual_bound',None) is not None else None,'ms':round((time.perf_counter()-t)*1000,2)}
# Margine massimo, seguito da copertura massima a parita' di margine.
a=solve(margin)
if a['certified']:
 val=int(round(sum(margin[i] for i in a['indices'])))
 a2=solve(coverage,[LinearConstraint(margin,val,val)])
else:a2={'indices':[],'certified':False,'status':-1,'message':'Margine non certificato: secondo stadio non eseguito'}
# Copertura massima, seguita da margine massimo a parita' di copertura.
b=solve(coverage)
if b['certified']:
 val=int(round(sum(coverage[i] for i in b['indices'])))
 b2=solve(margin,[LinearConstraint(coverage,val,val)])
else:b2={'indices':[],'certified':False,'status':-1,'message':'Copertura non certificata: secondo stadio non eseguito'}
print(json.dumps({'solver':'scipy.optimize.milp / HiGHS','n':n,'vincoli':len(constraints),'margine':a,'marginePoiCopertura':a2,'copertura':b,'coperturaPoiMargine':b2}))
`;
const conflict11=(a,b)=>a.reqIds.some(id=>b.reqIds.includes(id))||(a.vehicleId===b.vehicleId&&a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd);
const safe11=rows=>rows.every((a,i)=>rows.slice(i+1).every(b=>!conflict11(a,b)));
const greedy11=rows=>{const selected=[];for(const c of [...rows].sort((a,b)=>b.cents-a.cents||a.id.localeCompare(b.id)))if(selected.every(x=>!conflict11(x,c)))selected.push(c);return selected;};
const describe11=rows=>({cicli:rows.length,missioniTotali:rows.reduce((s,x)=>s+x.missions,0),cicliConcatenati:rows.filter(x=>x.missions>1).length,richiesteServite:new Set(rows.flatMap(x=>x.reqIds)).size,veicoliUsati:new Set(rows.map(x=>x.vehicleId)).size,margineEuro:rows.reduce((s,x)=>s+x.cents,0)/100,commissioneTurentuEuro:rows.reduce((s,x)=>s+x.commissionCents,0)/100,kmTotali:+rows.reduce((s,x)=>s+x.km,0).toFixed(2),senzaConflitti:safe11(rows)});
function runMIP(rows){const payload=JSON.stringify({rows,limitSeconds:20});
 const opts={input:payload,encoding:'utf8',maxBuffer:32*1024*1024,timeout:100000};
 let p=spawnSync(process.env.TURENTU_PYTHON||'python',['-c',PYTHON],opts);
 if(p.error?.code==='ENOENT')p=spawnSync('py',['-3','-c',PYTHON],opts);
 if(p.status!==0)throw Error('Python/SciPy non disponibile o errore solver. Installa: py -m pip install scipy numpy. Dettagli: '+(p.stderr||p.error?.message||'exit '+p.status).slice(0,1200));
 return JSON.parse(p.stdout);
}
const scenarios={};const checks=[];const check=(test,pass)=>checks.push({test,pass:!!pass});
for(const [name,rows] of [['soloSingole',checked.filter(x=>x.missions===1)],['singoleConcatenate',checked]]){
 const base=greedy11(rows),res=runMIP(rows);
 const materialize=stage=>stage.indices.map(i=>rows[i]);
 const stages={};for(const k of ['margine','marginePoiCopertura','copertura','coperturaPoiMargine']){
  const r=res[k],selection=materialize(r);stages[k]={...describe11(selection),certificatoOttimo:r.certified,statoSolver:r.status,gap:r.gap??null,limiteSuperiore:r.dualBound??null,nodi:r.nodes??null,tempoMs:r.ms??null,messaggio:r.message};
  check(name+' '+k+' senza conflitti',safe11(selection));
 }
 scenarios[name]={candidate:rows.length,vincoliMIP:res.vincoli,greedy:describe11(base),...stages};
 check(name+' MIP margine non inferiore a greedy se certificato',!res.margine.certified||stages.margine.margineEuro+1e-6>=scenarios[name].greedy.margineEuro);
 check(name+' secondo stadio margine preservato',!res.marginePoiCopertura.certified||Math.abs(stages.marginePoiCopertura.margineEuro-stages.margine.margineEuro)<1e-6);
 check(name+' secondo stadio copertura preservata',!res.coperturaPoiMargine.certified||stages.coperturaPoiMargine.richiesteServite===stages.copertura.richiesteServite);
}
// Caso controllato in cui la concatenazione e' strettamente migliore di ogni singola missione.
const fixture=[
 {id:'singolaA',vehicleId:1,ownerId:7,reqIds:['A'],busyStart:0,busyEnd:20,missions:1,cents:500,commissionCents:75,km:10},
 {id:'singolaB',vehicleId:1,ownerId:7,reqIds:['B'],busyStart:10,busyEnd:30,missions:1,cents:500,commissionCents:75,km:10},
 {id:'concatAB',vehicleId:1,ownerId:7,reqIds:['A','B'],busyStart:0,busyEnd:30,missions:2,cents:1250,commissionCents:150,km:15},
 {id:'altroVeicolo',vehicleId:2,ownerId:7,reqIds:['C'],busyStart:0,busyEnd:30,missions:1,cents:300,commissionCents:45,km:7}
];
const fixtureResult=runMIP(fixture);const chosen=fixtureResult.margine.indices.map(i=>fixture[i]);
check('Fixture concatenazione ottimale certificata',fixtureResult.margine.certified&&chosen.some(x=>x.id==='concatAB'));
check('Fixture veicoli stesso titolare simultanei',chosen.some(x=>x.id==='altroVeicolo')&&safe11(chosen));
check('Fixture margine atteso 15,50 euro',describe11(chosen).margineEuro===15.5);
check('PIXEL corridoi presenti',corridors.length>0);check('POPBUS candidate controllo presenti',popbusRaw.length>0);
check('Adapter cicli 1-3 validati',checked.some(x=>x.missions===1)&&checked.some(x=>x.missions===2)&&checked.some(x=>x.missions===3));
check('Nessuna attivazione',checked.every(x=>x.attivabile===false));
const report={test:'TURENTU TEST 11 — MILP VINCOLATO CICLI 1-3 MISSIONI',modalita:'SOLA LETTURA, moduli PIXEL/POPBUS/adapter reali, dati sintetici, solver SciPy HiGHS esterno',
 avvertenze:['Richiede Python con numpy e scipy; nessun DB/worker, nessuna modifica a produzione.','POPBUS genera candidate di controllo, non inserite nel MILP.','Greedy sperimentale, non scegliAttivazioni produttivo.','Certificazione soltanto quando status solver = 0; altri stati NON sono ottimi provati.','Vincoli: richiesta usata al massimo una volta, stesso veicolo senza intervalli sovrapposti; driver_id titolare non e un vincolo.','Intervalli busyStart/busyEnd e costi derivano da adapter su routing mock; non verifica conducente fisico o riposizionamento tra cicli distinti.','Secondi stadi lessicografici eseguiti soltanto se il primo stadio e certificato.'],
 dataset:{richieste:requests.length,veicoli:vehicles.length,corridoiPixel:corridors.length,candidatePopbus:popbusRaw.length,cicliValidati:checked.length,cicliUnaMissione:checked.filter(x=>x.missions===1).length,cicliDueMissioni:checked.filter(x=>x.missions===2).length,cicliTreMissioni:checked.filter(x=>x.missions===3).length,diagnosticaMs:+diagnosisMs.toFixed(2),rifiuti:rejected},scenari:scenarios,fixtureConcatenazione:{soluzione:describe11(chosen),selezionati:chosen.map(x=>x.id),certificatoOttimo:fixtureResult.margine.certified},checks,passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass).length};
console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
