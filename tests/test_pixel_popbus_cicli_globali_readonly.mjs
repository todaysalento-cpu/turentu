// TURENTU TEST 9 — PIXEL P2.1 + adapter POPBUS: cicli da 1/2/3 missioni, selezione flotta.
// SOLA LETTURA. Salvare in tests/test_pixel_popbus_cicli_globali_readonly.mjs
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
const conflict=(a,b)=>a.reqIds.some(id=>b.reqIds.includes(id))||
 (a.vehicleId===b.vehicleId&&a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd);
const sorted=rows=>[...rows].sort((a,b)=>b.cents-a.cents||a.id.localeCompare(b.id));
function greedy(rows){const out=[];for(const c of sorted(rows))if(!out.some(x=>conflict(x,c)))out.push(c);return out;}
function components(rows){const remain=new Set(rows),out=[];
 while(remain.size){const first=remain.values().next().value;remain.delete(first);const stack=[first],part=[];
  while(stack.length){const a=stack.pop();part.push(a);for(const b of [...remain])if(conflict(a,b)){remain.delete(b);stack.push(b);}}
  out.push(part);
 }return out;
}
// Ricerca esatta per componenti <= 18 candidate; altrimenti fallback esplicito.
function optimize(rows,limit=18){const parts=components(rows),chosen=[];let exact=0,fallback=0,nodesVisited=0;
 for(const part of parts){if(part.length>limit){chosen.push(...greedy(part));fallback++;continue;}
  exact++;const candidates=sorted(part),best={score:-1,ids:[],items:[]};
  const dfs=(i,selected,score)=>{nodesVisited++;if(i===candidates.length){
    const ids=selected.map(c=>c.id).sort();if(score>best.score||(score===best.score&&ids.join('|')<best.ids.join('|'))){best.score=score;best.ids=ids;best.items=[...selected];}return;
   }
   dfs(i+1,selected,score);
   const c=candidates[i];if(selected.every(s=>!conflict(s,c))){selected.push(c);dfs(i+1,selected,score+c.cents);selected.pop();}
  };dfs(0,[],0);chosen.push(...best.items);
 }
 return {selected:chosen,exact: fallback===0,components:parts.length,componentMax:Math.max(0,...parts.map(p=>p.length)),exactComponents:exact,fallbackComponents:fallback,nodesVisited};
}
const metrics=rows=>({cicli:rows.length,missioniTotali:rows.reduce((s,c)=>s+c.missions,0),
 richiesteServite:new Set(rows.flatMap(c=>c.reqIds)).size,veicoliUsati:new Set(rows.map(c=>c.vehicleId)).size,
 margineEuro:Math.round(rows.reduce((s,c)=>s+c.cents,0))/100,
 commissioneTurentuEuro:Math.round(rows.reduce((s,c)=>s+c.commissionCents,0))/100,
 kmTotali:Math.round(rows.reduce((s,c)=>s+c.km,0)*100)/100,
 duplicatiRichieste:new Set(rows.flatMap(c=>c.reqIds)).size!==rows.reduce((s,c)=>s+c.reqIds.length,0),
 conflitti:rows.some((a,i)=>rows.slice(i+1).some(b=>conflict(a,b)))});
const cases={};for(const [name,rows] of [['soloSingole',checked.filter(c=>c.missions===1)],['singoleConcatenate',checked]]){
 const t=performance.now(),g=greedy(rows),gMs=performance.now()-t;
 const t2=performance.now(),opt=optimize(rows),optMs=performance.now()-t2;
 cases[name]={candidate:rows.length,greedy:metrics(g),globale:metrics(opt.selected),ottimizzazione:{certificatoOttimo:opt.exact,componenti:opt.components,componenteMassima:opt.componentMax,componentiEsatte:opt.exactComponents,componentiFallback:opt.fallbackComponents,nodiVisitati:opt.nodesVisited},tempiMs:{greedy:+gMs.toFixed(3),globale:+optMs.toFixed(3)}};
}
const checks=[];const check=(name,pass)=>checks.push({test:name,pass:Boolean(pass)});
check('PIXEL ha generato corridoi',corridors.length>0);
check('PIXEL ha generato missioni validate da POPBUS',missionRows.length>0);
check('POPBUS ha generato candidate proprie',popbusRaw.length>0);
check('Cicli diagnostici economicamente validi',checked.length>0);
check('Almeno un ciclo concatenato validato',checked.some(c=>c.missions>=2));
check('Almeno un ciclo a tre missioni validato',checked.some(c=>c.missions===3));
check('Nessun ciclo diagnostico attivato',checked.every(c=>c.attivabile===false));
check('Callback preliminari passate',checked.every(c=>c.validated));
for(const [name,x] of Object.entries(cases)){
 check(`${name}: greedy senza conflitti`,!x.greedy.conflitti&&!x.greedy.duplicatiRichieste);
 check(`${name}: globale senza conflitti`,!x.globale.conflitti&&!x.globale.duplicatiRichieste);
 if(x.ottimizzazione.certificatoOttimo)check(`${name}: globale non inferiore alla greedy`,x.globale.margineEuro>=x.greedy.margineEuro);
 check(`${name}: certificazione solo senza fallback`,x.ottimizzazione.certificatoOttimo===(x.ottimizzazione.componentiFallback===0));
}
const report={test:'TURENTU TEST 9 — PIXEL/POPBUS CICLI CONCATENATI + SELEZIONE GLOBALE',
 modalita:'SOLA LETTURA, moduli reali, richieste/veicoli/routing sintetici',
 limiti:['Le missioni derivano da corridoi PIXEL reali e sono validate dall adapter POPBUS; le sequenze da 2-3 missioni sono enumerate nel test.',
 'Non prova il planner reale, il worker, la disponibilita DB, il routing stradale o la concorrenza transazionale.',
 'POPBUS genera candidate come controllo, ma il selettore confrontato e un greedy sperimentale, NON scegliAttivazioni del worker.',
 'La selezione globale e esatta solo se nessuna componente supera 18 candidate; fallback greedy altrimenti.',
 'Il ritorno alla base e gia incluso nell economia del singolo ciclo; non si presume che due cicli sullo stesso veicolo siano concatenati fisicamente.',
 'I margini sono dei cicli, NON gli utili della piattaforma.'],
 dataset:{richieste:requests.length,veicoli:vehicles.length,corridoiPixel:corridors.length,
 missioniPixelValidate:missionRows.length,candidatePopbus:popbusRaw.length,pianiUnici:uniquePlans.length,
 cicliValidati:checked.length,cicliUnaMissione:checked.filter(c=>c.missions===1).length,
 cicliDueMissioni:checked.filter(c=>c.missions===2).length,cicliTreMissioni:checked.filter(c=>c.missions===3).length,
 diagnosticaMs:+diagnosisMs.toFixed(2),rifiuti:rejected},
 scenari:cases,checks,passed:checks.filter(c=>c.pass).length,failed:checks.filter(c=>!c.pass).length};
console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
