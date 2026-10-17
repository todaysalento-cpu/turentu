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

// TEST 10: riduzione conservativa, euristica, oracolo esatto e ricerca a tempo.
// La disponibilita e modellata tramite [busyStart,busyEnd); il driver_id e titolare, non conducente.
const timeOverlap=(a,b)=>a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd;
const conflict=(a,b)=>a.reqIds.some(id=>b.reqIds.includes(id))||(a.vehicleId===b.vehicleId&&timeOverlap(a,b));
const score=rows=>rows.reduce((s,c)=>s+c.cents,0);
const sorted=rows=>[...rows].sort((a,b)=>b.cents-a.cents||a.id.localeCompare(b.id));
const safe=rows=>rows.every((a,i)=>rows.slice(i+1).every(b=>!conflict(a,b)));
const greedy=rows=>{const out=[];for(const c of sorted(rows))if(out.every(x=>!conflict(x,c)))out.push(c);return out;};
const describe=rows=>({cicli:rows.length,missioniTotali:rows.reduce((s,c)=>s+c.missions,0),richiesteServite:new Set(rows.flatMap(c=>c.reqIds)).size,veicoliUsati:new Set(rows.map(c=>c.vehicleId)).size,margineEuro:score(rows)/100,commissioneTurentuEuro:rows.reduce((s,c)=>s+c.commissionCents,0)/100,kmTotali:+rows.reduce((s,c)=>s+c.km,0).toFixed(2),senzaConflitti:safe(rows),cicliConcatenati:rows.filter(c=>c.missions>1).length});
// Solo equivalenza stretta: stesso veicolo, richieste, intervallo temporale.
// Non elimina per "dominanza" sulla sola richiesta: potrebbe cambiare la fattibilita temporale.
function reduceSafe(rows){const map=new Map();let duplicates=0,dominated=0;
 for(const c of rows){const key=[c.vehicleId,[...c.reqIds].sort().join(','),c.busyStart,c.busyEnd].join('|');const old=map.get(key);
  if(!old){map.set(key,c);continue;}
  if(c.cents===old.cents){duplicates++;if(c.id<old.id)map.set(key,c);}
  else {dominated++;if(c.cents>old.cents)map.set(key,c);}
 }
 return {rows:[...map.values()],duplicates,dominated};
}
// Scambi 1->1 e 1->2, e inserimenti gratuiti; monotonicita del margine garantita.
function improve(rows,initial,{passes=4,limitMs=350}={}){const start=performance.now();let selected=[...initial],moves=0,examined=0,expired=false;
 for(let pass=0;pass<passes;pass++){let bestGain=0,bestNext=null;
  const selectedIds=new Set(selected.map(x=>x.id));
  const unused=sorted(rows.filter(c=>!selectedIds.has(c.id)));
  for(const a of unused){if(performance.now()-start>limitMs){expired=true;break;}
   const removed=selected.filter(s=>conflict(s,a));const remaining=selected.filter(s=>!conflict(s,a));
   const gain=a.cents-score(removed);examined++;
   if(gain>bestGain){bestGain=gain;bestNext=[...remaining,a];}
   // Un secondo inserimento, senza conflitti con il primo o il residuo.
   for(const b of unused){if(b.id<=a.id||conflict(a,b))continue;
    if(performance.now()-start>limitMs){expired=true;break;}
    const removed2=selected.filter(s=>conflict(s,a)||conflict(s,b));
    const gain2=a.cents+b.cents-score(removed2);examined++;
    if(gain2>bestGain){bestGain=gain2;bestNext=[...selected.filter(s=>!removed2.includes(s)),a,b];}
   }
   if(expired)break;
  }
  if(bestNext&&bestGain>0){selected=bestNext;moves++;}else break;
  if(expired)break;
 }
 return {selected,moves,examined,expired,ms:+(performance.now()-start).toFixed(2)};
}
// Oracolo esatto per piccoli insiemi: esplorazione completa con pruning ammissibile.
function exactOracle(rows){const cand=sorted(rows);if(cand.length>18)throw Error('Oracle max 18');let best=[],bestScore=-1,visited=0;
 const suffix=new Array(cand.length+1).fill(0);for(let i=cand.length-1;i>=0;i--)suffix[i]=suffix[i+1]+Math.max(0,cand[i].cents);
 function dfs(i,chosen,total){visited++;if(total+suffix[i]<bestScore)return;
  if(i===cand.length){if(total>bestScore){bestScore=total;best=[...chosen];}return;}
  const c=cand[i];if(chosen.every(x=>!conflict(x,c))){chosen.push(c);dfs(i+1,chosen,total+c.cents);chosen.pop();}
  dfs(i+1,chosen,total);
 }dfs(0,[],0);return {selected:best,visited,certificatoOttimo:true};
}
// BnB a tempo sul dataset completo. Upper bound ammissibile: somma di tutti i margini
// positivi residui (debole ma corretta). Timeout => migliore soluzione ammissibile, NON ottimo.
function boundedSearch(rows,incumbent,{limitMs=500,maxNodes=100000}={}){
 const start=performance.now(),cand=sorted(rows),n=cand.length;
 const suffix=new Array(n+1).fill(0);for(let i=n-1;i>=0;i--)suffix[i]=suffix[i+1]+Math.max(0,cand[i].cents);
 let best=[...incumbent],bestScore=score(best),visited=0,timedOut=false;
 function dfs(i,chosen,total){if(timedOut)return;visited++;
  if(visited>maxNodes||(visited%256===0&&performance.now()-start>limitMs)){timedOut=true;return;}
  if(total+suffix[i]<=bestScore)return;
  if(i===n){if(total>bestScore){best=[...chosen];bestScore=total;}return;}
  const c=cand[i];if(chosen.every(x=>!conflict(x,c))){chosen.push(c);dfs(i+1,chosen,total+c.cents);chosen.pop();}
  dfs(i+1,chosen,total);
 }
 dfs(0,[],0);
 return {selected:best,certificatoOttimo:!timedOut,visited,timedOut,ms:+(performance.now()-start).toFixed(2),upperBoundEuro:timedOut?null:bestScore/100};
}
const scenarios={};const checks=[];const check=(name,pass)=>checks.push({test:name,pass:Boolean(pass)});
for(const [name,input] of [['soloSingole',checked.filter(c=>c.missions===1)],['singoleConcatenate',checked]]){
 const red=reduceSafe(input),rows=red.rows;
 const t0=performance.now(),base=greedy(rows),greedyMs=+(performance.now()-t0).toFixed(2);
 const improved=improve(rows,base,{passes:3,limitMs:350});
 const bounded=boundedSearch(rows,improved.selected,{limitMs:500,maxNodes:100000});
 // Oracolo su 18 candidate di uno stesso sottoinsieme, confronto corretto sullo stesso universo.
 const small=sorted(rows).slice(0,Math.min(18,rows.length));const oracle=exactOracle(small),smallGreedy=greedy(small);
 const reductionPreserves=rows.every(c=>input.some(x=>x.id===c.id));
 scenarios[name]={candidateOriginali:input.length,candidateRidotte:rows.length,riduzione:{duplicati: red.duplicates,dominateEquivalenti:red.dominated},
  greedy:describe(base),scambiLocali:describe(improved.selected),ricercaLimitata:describe(bounded.selected),
  ottimizzazione:{certificatoOttimo:bounded.certificatoOttimo,timeout:bounded.timedOut,nodiVisitati:bounded.visited,tempoMs:bounded.ms,limiteSuperioreEuro:bounded.upperBoundEuro},
  oraclePiccolo:{candidate:small.length,greedy:describe(smallGreedy),esatto:describe(oracle.selected),nodiVisitati:oracle.visited,certificatoOttimo:true},
  scambi:{miglioramenti:improved.moves,candidateEsaminate:improved.examined,budgetEsaurito:improved.expired,tempoMs:improved.ms},tempiMs:{greedy:greedyMs}};
 check(name+': riduzione conservativa',reductionPreserves&&rows.length<=input.length);
 check(name+': greedy senza conflitti',safe(base));
 check(name+': scambi locali senza conflitti',safe(improved.selected));
 check(name+': ricerca limitata senza conflitti',safe(bounded.selected));
 check(name+': scambi locali non peggiorano greedy',score(improved.selected)>=score(base));
 check(name+': ricerca limitata non peggiora scambi',score(bounded.selected)>=score(improved.selected));
 check(name+': oracolo esatto non inferiore a greedy',score(oracle.selected)>=score(smallGreedy));
 check(name+': certificazione coerente con timeout',bounded.certificatoOttimo===!bounded.timedOut);
 check(name+': conflitti per veicolo non per titolare',vehicles.some((v,i)=>vehicles.some((w,j)=>i!==j&&v.driver_id===w.driver_id)));
}
check('PIXEL ha generato corridoi',corridors.length>0);
check('POPBUS ha generato candidate',popbusRaw.length>0);
check('Cicli 1, 2 e 3 missioni validati',checked.some(c=>c.missions===1)&&checked.some(c=>c.missions===2)&&checked.some(c=>c.missions===3));
check('Diagnostica non attiva corse',checked.every(c=>c.attivabile===false));
check('Validazione preliminare superata',checked.every(c=>c.validated===true));
const report={test:'TURENTU TEST 10 — OTTIMIZZAZIONE CICLI 1-3 MISSIONI, RIDUZIONE, ORACOLO, TIMEOUT',
 modalita:'SOLA LETTURA; moduli reali PIXEL/POPBUS/adapter; richieste, veicoli, routing MOCK',
 avvertenze:['Nessun DB o worker importato; non attiva corse.','POPBUS genera candidate di controllo, non vengono inserite nel selettore.',
 'Greedy e ottimizzatori sono sperimentali nel test; non rappresentano scegliAttivazioni del worker.',
 'Il solver completo usa un bound valido ma debole: timeout o limite nodi significa ottimo NON certificato.',
 'Oracolo esatto soltanto su 18 candidate, non su tutte le candidate.',
 'Dominanza limitata a veicolo, richieste e intervallo identici; altre riduzioni rischierebbero falsi scarti.',
 'Ritorno base incluso in ciascun ciclo; i cicli multipli su stesso veicolo richiedono intervalli non sovrapposti.',
 'Il test non prova turni, conducenti fisici, transazioni, routing reale o planner produttivo.'],
 dataset:{richieste:requests.length,veicoli:vehicles.length,corridoiPixel:corridors.length,candidatePopbus:popbusRaw.length,pianiUnici:uniquePlans.length,cicliValidati:checked.length,
  cicliUnaMissione:checked.filter(c=>c.missions===1).length,cicliDueMissioni:checked.filter(c=>c.missions===2).length,cicliTreMissioni:checked.filter(c=>c.missions===3).length,
  diagnosticaMs:+diagnosisMs.toFixed(2),rifiuti:rejected},scenari:scenarios,checks,passed:checks.filter(c=>c.pass).length,failed:checks.filter(c=>!c.pass).length};
console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
