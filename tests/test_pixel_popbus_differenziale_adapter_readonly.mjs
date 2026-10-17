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


// TEST 13 — Confronto differenziale, senza modifiche ai moduli reali.
const BUFFER_MIN=3;
const equal=(a,b,eps=1e-8)=>Math.abs(a-b)<=eps;
const independent=[];
const anomalies=[];
const counts={total:0,valid:0,rejected:0,one:0,multi:0,bufferSensitive:0,approachLate:0,incorrectEconomics:0,incorrectBusy:0,incorrectTransfers:0,incorrectTemporal:0};
const reasonCounts={};
const examples={};
const note=(type,data)=>{if(!examples[type])examples[type]=[];if(examples[type].length<5)examples[type].push(data)};
// Ricalcolo geometrico indipendente: usa il routing mock, non economia o trasferimenti restituiti dall'adapter.
async function oracle(plan,vehicle){
 const corr=plan.map(m=>engine.getCorridor(m.corridorId));
 const ev=[];
 for(let i=0;i<plan.length;i++){
  const m=plan[i],c=corr[i],ids=m.requestIds.map(Number),sel=ids.map(id=>byId.get(id));
  ev.push(valutaRichieste({nodes:c.nodes,legs:c.legs},sel,ids,{mode:'seeds_only',maxPeak:vehicle.posti_totali}));
 }
 const approach=await road(vehicle,byNode.get(Number(corr[0].nodes[0])));
 const back=await road(byNode.get(Number(corr.at(-1).nodes.at(-1))),vehicle);
 const transfers=[];
 for(let i=1;i<corr.length;i++){
  const r=await road(byNode.get(Number(corr[i-1].nodes.at(-1))),byNode.get(Number(corr[i].nodes[0])));
  const slack=ev[i].departure-ev[i-1].arrival-r.seconds*1000;
  transfers.push({metres:r.metres,seconds:r.seconds,slackMs:slack});
 }
 const approachStart=ev[0].departure-approach.seconds*1000;
 const commercial=corr.reduce((s,c)=>s+c.legs.reduce((z,l)=>z+Number(l.metres),0),0);
 const km={avvicinamento:approach.metres/1000,missioni:commercial/1000,trasferimenti:transfers.reduce((s,x)=>s+x.metres,0)/1000,ritornoBase:back.metres/1000};
 const total=Object.values(km).reduce((a,b)=>a+b,0);
 const gross=plan.reduce((s,m)=>s+m.requestIds.reduce((t,id)=>t+Number(byId.get(Number(id)).prezzo),0),0);
 const grossCents=Math.round(gross*100),commCents=Math.round(grossCents*0.15);
 const kmCostCents=Math.ceil(total*vehicle.euro_km*100-1e-9);
 const waitingHours=transfers.reduce((s,t)=>s+Math.max(0,t.slackMs),0)/3600000;
 const waitCents=Math.round(waitingHours*2*100);
 return {km,total,gross,commissionEuro:commCents/100,costEuro:(kmCostCents+waitCents)/100,
  marginEuro:(grossCents-commCents-kmCostCents-waitCents)/100,
  busyStart:approachStart,busyEnd:ev.at(-1).arrival+back.seconds*1000,
  transfers,bufferFeasible:transfers.every(x=>x.slackMs>=BUFFER_MIN*60000),
  temporalFeasible:transfers.every(x=>x.slackMs>=0),
  approachLate:approachStart<=Date.parse('2029-01-01T00:00:00Z'),
  sameVehicle:true};
}
for(const p of uniquePlans)for(const v of vehicles){
 counts.total++;
 const r=await diagnosticaCicloPixelPopbus({engine,missioni:p,richieste:requests,vehicle:v,nodes,road,
  now:Date.parse('2029-01-01T00:00:00Z'),maxWaitMin:180,costoAttesaOraEuro:2,
  validateVehicle:async()=>true,validateCandidate:async()=>true});
 if(!r.ok){counts.rejected++;reasonCounts[r.motivo]=(reasonCounts[r.motivo]||0)+1;continue;}
 counts.valid++;if(p.length===1)counts.one++;else counts.multi++;
 const o=await oracle(p,v);
 const identity=`${v.id}|${planKey(p)}`;
 const economics=equal(r.economia.km.totali,o.total)&&equal(r.economia.margineEuro,o.marginEuro)&&equal(r.economia.commissioneTurentuEuro,o.commissionEuro)&&equal(r.economia.costoCompletoEuro,o.costEuro)&&Object.keys(o.km).every(k=>equal(r.economia.km[k],o.km[k]));
 const busy=equal(r.busyStart,o.busyStart)&&equal(r.busyEnd,o.busyEnd);
 const transfer= r.trasferimenti.length===o.transfers.length&&r.trasferimenti.every((t,i)=>equal(t.metres,o.transfers[i].metres)&&equal(t.seconds,o.transfers[i].seconds)&&equal(t.attesaMinuti,o.transfers[i].slackMs/60000));
 if(!economics){counts.incorrectEconomics++;note('ECONOMIA_DIFFERENTE',{id:identity,adapter:r.economia,oracle:o})}
 if(!busy){counts.incorrectBusy++;note('BUSY_DIFFERENTE',{id:identity,adapter:[r.busyStart,r.busyEnd],oracle:[o.busyStart,o.busyEnd]})}
 if(!transfer){counts.incorrectTransfers++;note('TRASFERIMENTI_DIFFERENTI',{id:identity,adapter:r.trasferimenti,oracle:o.transfers})}
 if(!o.temporalFeasible){counts.incorrectTemporal++;note('TEMPO_INCOERENTE',{id:identity,oracle:o.transfers})}
 if(!o.bufferFeasible){counts.bufferSensitive++;note('BUFFER_3_MIN_NON_RISPETTATO',{id:identity,slackMinutes:o.transfers.map(x=>x.slackMs/60000)})}
 if(o.approachLate){counts.approachLate++;note('AVVICINAMENTO_NON_FATTIBILE',{id:identity})}
}
const checks=[
 ['Candidate reali PIXEL disponibili',corridors.length>0],
 ['Candidate controllo POPBUS disponibili',popbusRaw.length>0],
 ['Cicli validi adapter presenti',counts.valid>0],
 ['Cicli concatenati adapter presenti',counts.multi>0],
 ['Contabilita adapter e oracolo indipendente coerenti',counts.incorrectEconomics===0],
 ['Occupazione veicolo adapter e oracolo coerenti',counts.incorrectBusy===0],
 ['Trasferimenti adapter e oracolo coerenti',counts.incorrectTransfers===0],
 ['Nessuna concatenazione temporalmente impossibile accettata',counts.incorrectTemporal===0],
 ['Nessuna attivazione o scrittura',checked.every(x=>x.attivabile===false)],
].map(([test,pass])=>({test,pass}));
const result={test:'TURENTU TEST 13 — DIFFERENZIALE ADAPTER REALE VS ORACOLO INDIPENDENTE',
 mode:'SOLA LETTURA; routing sintetico condiviso, calcoli economici e temporali indipendenti',
 limits:[
 'Usa engine PIXEL, modello POPBUS e adapter reali del progetto, ma routing mock; nessun DB o worker.',
 'Oracolo indipendente nella logica dei conti, ma usa la stessa geometria simulata e le valutazioni temporali POPBUS.',
 'Il buffer 3 minuti NON e un parametro dell adapter: i casi bufferSensitive sono un gap di policy, non necessariamente un bug.',
 'Nessun controllo sul riposizionamento tra cicli distinti o sulla presenza del conducente fisico.',
 'Il confronto economico usa il costo attesa di 2 EUR/ora e arrotondamento ai centesimi.'
 ],dataset:{richieste:requests.length,veicoli:vehicles.length,corridoiPixel:corridors.length,candidatePopbus:popbusRaw.length,piani:uniquePlans.length},
 counts,reasonsRejected:reasonCounts,examples,checks,passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass).length};
console.log(JSON.stringify(result,null,2));
if(result.failed)process.exitCode=1;
