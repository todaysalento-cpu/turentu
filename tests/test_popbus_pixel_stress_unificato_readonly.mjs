/**
 * TURENTU POPBUS - PIXEL benchmark isolato, deterministico, senza I/O esterno.
 * Eseguire da CMD: node --expose-gc tests\test_popbus_pixel_stress_unificato_readonly.mjs --sizes=100,500,1000,5000,10000,25000,50000 --scenario=all
 * Basato sui prototipi test_popbus_copertura_pixel, candidate_dirette_pixel,
 * multicorridoio_scalabilita_readonly. NON importa il worker e NON certifica
 * matching V2, fattibilita' stradale, qualita', economia o completezza multi-corridoio.
 */
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';

const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--') && x.includes('=')).map(x => {const i=x.indexOf('=');return [x.slice(2,i),x.slice(i+1)];}));
const integer=(key,def,min,max)=>{const n=Number(args[key]??def);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`--${key} deve essere un intero ${min}..${max}`);return n;};
const sizes=(args.sizes??'100,500,1000,5000,10000,25000,50000').split(',').map(Number);
if(!sizes.length||sizes.some(n=>!Number.isSafeInteger(n)||n<2||n>100000))throw Error('--sizes: interi tra 2 e 100000');
const mode=args.scenario??'all';
if(!['all','distribuito','concentrato','estremo'].includes(mode))throw Error('--scenario=all|distribuito|concentrato|estremo');
const scenarios=mode==='all'?['distribuito','concentrato','estremo']:[mode];
const seed=integer('seed',20261014,1,2147483647);
const bucketMin=integer('bucket',10,1,60);
const tolMin=integer('tolerance',30,0,120);
const oracleMax=integer('oracle-max',500,0,2000);
const maxChecks=integer('max-checks',3000000,1000,200000000);
const maxMs=integer('max-ms',15000,100,120000);
const maxHeapMB=integer('max-heap-mb',700,32,16000);
const maxPairs=integer('max-pairs',500000,1000,20000000);
const base=Date.UTC(2027,3,1,8,0),minute=60000,bucketMs=bucketMin*minute,tolMs=tolMin*minute;
const clock=()=>performance.now();
function rng(s){let x=s>>>0;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;};}
const cell=(c,s,b)=>`${c}:${s}:${b}`;
const mb=()=>+(process.memoryUsage().heapUsed/1048576).toFixed(2);
function fixture(n,scenario){
 const r=rng((seed+n*31+{distribuito:1,concentrato:2,estremo:3}[scenario])>>>0),out=[];
 const corridors=scenario==='distribuito'?Math.max(16,Math.ceil(n/25)):scenario==='concentrato'?2:1;
 const slots=scenario==='distribuito'?144:scenario==='concentrato'?12:1;
 for(let i=0;i<n;i++){
  const corridor=Math.floor(r()*corridors);
  const start=scenario==='estremo'?0:Math.floor(r()*(scenario==='concentrato'?12:40));
  const length=scenario==='estremo'?8:2+Math.floor(r()*6);
  const time=base+Math.floor(r()*slots)*bucketMs;
  out.push({id:i+1,corridor,start,end:start+length,time});
 }
 return out;
}
// Conserva i pixel segmento-tempo dei prototipi; estende i bucket per tolleranza.
function indexRequests(reqs){
 const index=new Map(),byId=new Map();let postings=0;
 for(const r of reqs){
  byId.set(r.id,r);
  for(let s=r.start;s<r.end;s++){
   const t=r.time+(s-r.start)*10*minute;
   const lo=Math.floor((t-tolMs)/bucketMs)-1,hi=Math.floor((t+tolMs)/bucketMs)+1;
   for(let b=lo;b<=hi;b++){
    const k=cell(r.corridor,s,b);let list=index.get(k);
    if(!list){list=[];index.set(k,list);}list.push(r.id);postings++;
   }
  }
 }
 return {index,byId,postings};
}
function covers(route,r){
 if(route.corridor!==r.corridor||route.start>r.start||route.end<r.end)return false;
 const arrival=route.time+(r.start-route.start)*10*minute;
 return Math.abs(arrival-r.time)<=tolMs;
}
// Ogni richiesta definisce una traiettoria-ancora. Non genera nuove traiettorie.
function pixelQuery(anchor,idx,stats,deadline){
 const seen=new Set(),bucketAt=t=>Math.floor(t/bucketMs);
 for(let s=anchor.start;s<anchor.end;s++){
  const t=anchor.time+(s-anchor.start)*10*minute;
  const list=idx.index.get(cell(anchor.corridor,s,bucketAt(t)));
  stats.lookups++;
  if(list)for(const id of list){seen.add(id);stats.postingsVisited++;}
 }
 let accepted=0;
 for(const id of seen){
  stats.checks++;
  if(stats.checks>maxChecks||(stats.checks%1024===0&&(clock()>deadline||mb()>maxHeapMB))){stats.stopped=true;break;}
  if(covers(anchor,idx.byId.get(id)))accepted++;
 }
 return {accepted,seen:seen.size};
}
// Baseline indipendente dall'indice: scansione integrale per ogni ancora.
function oracle(reqs,anchor){let found=0;for(const r of reqs)if(covers(anchor,r))found++;return found;}
// Statistica delle coppie potenziali senza materializzarle (duplicati tra celle inclusi).
function estimatePairs(index){let raw=0,maxOccupants=0;for(const ids of index.values()){
 const k=ids.length;raw+=k*(k-1)/2;if(k>maxOccupants)maxOccupants=k;
 }return {raw,maxOccupants};}
function run(n,scenario){
 if(global.gc)global.gc();
 const t0=clock(),cpu0=process.cpuUsage(),heapBefore=mb();
 const reqs=fixture(n,scenario),t1=clock();
 const idx=indexRequests(reqs),t2=clock();
 const potential=estimatePairs(idx.index),t3=clock();
 const stats={checks:0,lookups:0,postingsVisited:0,stopped:false};
 let anchors=0,acceptedTotal=0,oracleMismatches=0,oracleCompared=0;
 const deadline=clock()+maxMs;
 let stopReason=null;
 for(const anchor of reqs){
  if(clock()>deadline){stopReason='TIME_BUDGET';break;}
  if(mb()>maxHeapMB){stopReason='HEAP_BUDGET';break;}
  if(stats.checks>=maxChecks){stopReason='CHECK_BUDGET';break;}
  const result=pixelQuery(anchor,idx,stats,deadline);
  anchors++;acceptedTotal+=result.accepted;
  if(n<=oracleMax){
   const expected=oracle(reqs,anchor);oracleCompared++;
   if(result.accepted!==expected)oracleMismatches++;
  }
  if(stats.stopped){stopReason=stats.checks>maxChecks?'CHECK_BUDGET':clock()>deadline?'TIME_BUDGET':'HEAP_BUDGET';break;}
 }
 const t4=clock(),cpu=process.cpuUsage(cpu0),heapAfter=mb();
 const full=anchors===n&&!stopReason;
 const pairEnumerationStatus=potential.raw>maxPairs?'NON_MATERIALIZZATE_LIMITE':'NON_MATERIALIZZATE_SCELTA';
 return {scenario,richieste:n,completato:full,stopReason,ancoreAnalizzate:anchors,
  cellePixel:idx.index.size,presenzePixel:idx.postings,occupazioneMaxCella:potential.maxOccupants,
  coppieGrezzePotenziali:potential.raw,coppieUniche:'NON_CALCOLATE',enumerazioneCoppie:pairEnumerationStatus,
  lookupPixel:stats.lookups,postingsVisitati:stats.postingsVisited,verificheEsatte:stats.checks,
  confrontiOracleTeorici:n*n,riduzioneVerifichePct:+(100*(1-stats.checks/(Math.max(1,anchors)*n))).toFixed(2),
  richiesteCoperteTotali:acceptedTotal,oracleAncore:oracleCompared,oracleDifferenze:oracleCompared?oracleMismatches:null,
  msFixture:+(t1-t0).toFixed(2),msIndice:+(t2-t1).toFixed(2),msStimaCoppie:+(t3-t2).toFixed(2),
  msQuery:+(t4-t3).toFixed(2),msTotale:+(t4-t0).toFixed(2),
  throughputAncoreSec:+(anchors/Math.max((t4-t3)/1000,.000001)).toFixed(2),
  cpuUserMs:+(cpu.user/1000).toFixed(2),cpuSystemMs:+(cpu.system/1000).toFixed(2),
  heapPrimaMB:heapBefore,heapDopoMB:heapAfter,heapDeltaMB:+(heapAfter-heapBefore).toFixed(2),
  rssMB:+(process.memoryUsage().rss/1048576).toFixed(2)};
}
console.log(JSON.stringify({event:'CONFIG',sizes,scenarios,seed,bucketMin,tolMin,oracleMax,maxChecks,maxMs,maxHeapMB,maxPairs,cpuLogici:cpus().length,note:'Solo prototipo PIXEL su corridoi sintetici lineari; nessun DB, Google, worker, modello o planner. Limiti temporali best-effort sincroni.'}));
let failed=false;
for(const scenario of scenarios){for(const n of sizes){
 try{const row=run(n,scenario);console.log(JSON.stringify({event:'SCALA',...row}));if(row.oracleDifferenze>0)failed=true;}
 catch(e){failed=true;console.log(JSON.stringify({event:'ERRORE',scenario,richieste:n,messaggio:e.message}));}
}}
console.log(JSON.stringify({event:'FINE',esito:failed?'VERIFICARE':'COMPLETATO',nota:'Stop per budget non equivale a errore algoritmico; 0 differenze oracle prova solo copertura delle traiettorie-ancora sintetiche.'}));
if(failed)process.exitCode=1;
