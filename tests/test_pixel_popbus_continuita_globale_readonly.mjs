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


// TEST 14: audit della continuita' fra cicli. Non modifica DB/worker.
import {spawnSync} from 'node:child_process';
const PY=String.raw`import sys,json,time
import numpy as np
from scipy.optimize import milp,Bounds,LinearConstraint
from scipy.sparse import lil_matrix
p=json.load(sys.stdin);rows=p['rows'];mode=p['mode'];n=len(rows)
cs=[]; req=sorted({q for r in rows for q in r['reqIds']})
for q in req:cs.append([i for i,r in enumerate(rows) if q in r['reqIds']])
for i,a in enumerate(rows):
 for j in range(i+1,n):
  b=rows[j]
  if a['vehicleId']!=b['vehicleId']:continue
  overlap=a['busyStart']<b['busyEnd'] and b['busyStart']<a['busyEnd']
  # Operational gap: busyStart and busyEnd must include base departure and return.
  # Guard also against an additional turnaround buffer between cycles.
  gap=float(p.get('turnaroundMs',0))
  extra=(a['busyEnd']<=b['busyStart'] and b['busyStart']-a['busyEnd']<gap) or (b['busyEnd']<=a['busyStart'] and a['busyStart']-b['busyEnd']<gap)
  if overlap or (mode=='turnaround' and extra):cs.append([i,j])
A=lil_matrix((len(cs),n),dtype=float)
for k,ids in enumerate(cs):A[k,ids]=1
res=milp(c=-np.array([r['cents'] for r in rows],dtype=float),integrality=np.ones(n),bounds=Bounds(np.zeros(n),np.ones(n)),constraints=[LinearConstraint(A.tocsr(),0,1)],options={'time_limit':20,'mip_rel_gap':0.0})
sel=[i for i,v in enumerate(res.x) if v>.5] if res.x is not None else []
print(json.dumps({'selected':sel,'certified':bool(res.status==0),'status':int(res.status),'gap':float(res.mip_gap) if getattr(res,'mip_gap',None) is not None else None,'constraints':len(cs),'message':str(res.message)}))
`;
function solve(rows,mode='overlap',turnaroundMs=0){
 const opts={input:JSON.stringify({rows,mode,turnaroundMs}),encoding:'utf8',maxBuffer:32*1024*1024,timeout:90000};
 const configured=process.env.TURENTU_PYTHON;
 let p=spawnSync(configured||'py',configured?['-c',PY]:['-3','-c',PY],opts);
 if(p.error?.code==='ENOENT'&&!configured)p=spawnSync('python',['-c',PY],opts);
 if(p.status!==0)throw Error('Python SciPy: '+(p.stderr||p.error?.message||p.stdout||'exit '+p.status).slice(0,1300));
 return JSON.parse(p.stdout);
}
const checks=[];const check=(name,pass)=>checks.push({name,pass:!!pass});
const overlap=(a,b)=>a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd;
const conflict=(a,b,gap=0)=>a.reqIds.some(x=>b.reqIds.includes(x))||(a.vehicleId===b.vehicleId&&(overlap(a,b)||(gap>0&&Math.abs(a.busyEnd<=b.busyStart?b.busyStart-a.busyEnd:b.busyEnd<=a.busyStart?a.busyStart-b.busyEnd:0)<gap)));
const describe=rows=>({cicli:rows.length,richiesteServite:new Set(rows.flatMap(r=>r.reqIds)).size,veicoliUsati:new Set(rows.map(r=>r.vehicleId)).size,margineEuro:rows.reduce((a,r)=>a+r.cents,0)/100,commissioneEuro:rows.reduce((a,r)=>a+r.commissionCents,0)/100,kmTotali:+rows.reduce((a,r)=>a+r.km,0).toFixed(2)});
// Interpretazione rigorosa: se busyEnd include ritorno alla base, intervalli disgiunti
// garantiscono che entrambi i cicli inizino dalla base. Questo e' un ASSUNTO da auditare.
const malformed=checked.filter(r=>!(Number.isFinite(r.busyStart)&&Number.isFinite(r.busyEnd)&&r.busyEnd>r.busyStart));
const rows=checked.filter(r=>Number.isFinite(r.busyStart)&&Number.isFinite(r.busyEnd)&&r.busyEnd>r.busyStart);
const classic=solve(rows,'overlap');const selected=classic.selected.map(i=>rows[i]);
const turnaroundMs=3*60*1000;
const guarded=solve(rows,'turnaround',turnaroundMs);const selectedGuarded=guarded.selected.map(i=>rows[i]);
const pairs=[];const adjacent=[];let sameOwnerParallel=0, sameVehicleOverlaps=0;
for(let i=0;i<selected.length;i++)for(let j=i+1;j<selected.length;j++){
 const a=selected[i],b=selected[j];if(a.ownerId===b.ownerId&&a.vehicleId!==b.vehicleId&&overlap(a,b))sameOwnerParallel++;
 if(a.vehicleId!==b.vehicleId)continue;
 if(overlap(a,b))sameVehicleOverlaps++;
 const first=a.busyStart<=b.busyStart?a:b,last=first===a?b:a;
 const gapMin=(last.busyStart-first.busyEnd)/60000;
 if(gapMin>=0)adjacent.push({first:first.id,second:last.id,gapMin:+gapMin.toFixed(2),under3Min:gapMin<3});
}
// Fixture avversaria: busyEnd sottostimato (ritorno non incluso), dimostra che
// il semplice controllo di non sovrapposizione NON prova fattibilita' geografica.
const fixture=[
 {id:'A',vehicleId:1,ownerId:77,reqIds:['a'],busyStart:0,busyEnd:20*60000,cents:1000,commissionCents:150,km:10},
 {id:'B',vehicleId:1,ownerId:77,reqIds:['b'],busyStart:25*60000,busyEnd:45*60000,cents:900,commissionCents:135,km:10},
 {id:'C',vehicleId:2,ownerId:77,reqIds:['c'],busyStart:0,busyEnd:40*60000,cents:800,commissionCents:120,km:10}
];
// A termina al minuto 20 lontano dalla base, B richiede la base al minuto 25;
// ritorno A->base 15 min: A+B impossibile nonostante busy disgiunti.
const fixtureBase=solve(fixture,'overlap');const fixtureChosen=fixtureBase.selected.map(i=>fixture[i]);
const fixturePhysicalInvalid=fixtureChosen.some(x=>x.id==='A')&&fixtureChosen.some(x=>x.id==='B')&&20+15>25;
const fixtureCorrected=fixture.map(x=>x.id==='A'?{...x,busyEnd:35*60000}:x);
const fixtureFixed=solve(fixtureCorrected,'overlap');const fixtureFixedChosen=fixtureFixed.selected.map(i=>fixtureCorrected[i]);
check('Adapter ha prodotto cicli validi',rows.length>0);
check('Intervalli busy validi',malformed.length===0);
check('Ottimo base certificato',classic.certified);
check('Ottimo con turnaround certificato',guarded.certified);
check('Soluzione base senza duplicazioni e sovrapposizioni',selected.every((a,i)=>selected.slice(i+1).every(b=>!conflict(a,b))));
check('Soluzione turnaround senza conflitti',selectedGuarded.every((a,i)=>selectedGuarded.slice(i+1).every(b=>!conflict(a,b,turnaroundMs))));
check('Margine con turnaround non supera margine base',describe(selectedGuarded).margineEuro<=describe(selected).margineEuro+1e-6);
check('Fixture evidenzia rischio busyEnd incompleto',fixtureBase.certified&&fixturePhysicalInvalid);
check('Fixture con busyEnd corretto impedisce sequenza impossibile',fixtureFixed.certified&&!fixtureFixedChosen.some(x=>x.id==='A'&&fixtureFixedChosen.some(y=>y.id==='B')));
check('Veicolo diverso dello stesso titolare non viene bloccato',fixtureFixedChosen.some(x=>x.id==='C'));
check('Nessuna attivazione',checked.every(x=>x.attivabile===false));
const report={test:'TURENTU TEST 14 — CONTINUITA GLOBALE FLOTTA E CICLI',mode:'SOLA LETTURA; PIXEL/POPBUS/adapter reali; routing sintetico; MILP SciPy HiGHS',limits:[
 'Il dataset non contiene posizioni finali esplicite per ogni ciclo: non e possibile provare il riposizionamento geografico fra cicli senza ispezionare i dati interni.',
 'La compatibilita di due cicli non sovrapposti e garantita SOLO SE busyStart comprende partenza dalla base e busyEnd comprende ritorno alla stessa base.',
 'Il buffer di 3 minuti tra cicli e una policy sperimentale, non una regola produttiva.',
 'Fixture avversaria costruita appositamente: non implica che adapter reale sottostimi busyEnd.',
 'Non verifica turni dei conducenti, DB, worker o routing stradale reale.',
 'POPBUS e usato come generatore di controllo, non e il selettore confrontato con il MILP.'
],dataset:{richieste:requests.length,veicoli:vehicles.length,corridoiPixel:corridors.length,candidatePopbus:popbusRaw.length,piani:uniquePlans.length,cicliValidi:rows.length,intervalliNonValidi:malformed.length},
 selection:{base:{...describe(selected),solver:classic},turnaround3Min:{...describe(selectedGuarded),solver:guarded},differenzaMargineEuro:+(describe(selected).margineEuro-describe(selectedGuarded).margineEuro).toFixed(2),sovrapposizioniStessoVeicolo:sameVehicleOverlaps,paralleliStessoTitolareVeicoliDistinti:sameOwnerParallel,passaggiStessoVeicolo:adjacent.length,passaggiSotto3Min:adjacent.filter(x=>x.under3Min).length,esempiPassaggi:adjacent.slice(0,8)},
 fixture:{ottimoIntervalliSenzaRitorno:fixtureChosen.map(x=>x.id),sequenzaFisicamenteImpossibile:fixturePhysicalInvalid,ottimoIntervalliConRitorno:fixtureFixedChosen.map(x=>x.id)},checks,passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass).length};
console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
