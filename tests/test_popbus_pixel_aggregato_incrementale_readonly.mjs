/**
 * Turentu POPBUS - PIXEL aggregato incrementale, benchmark SINTETICO OFFLINE.
 * Nessun DB, Google Maps, worker, planner, file scritto o dipendenza esterna.
 * Testa: riferimenti ID per tratta/bucket, contatori, add/update/remove,
 * recupero per gruppo (firma identica), parita' con oracle su traiettorie-ancora.
 * NON certifica matching multi-tratta, assegnazione, capienza, economia o ritorno.
 */
import { performance } from 'node:perf_hooks';
const argv=Object.fromEntries(process.argv.slice(2).filter(x=>x.startsWith('--')&&x.includes('=')).map(x=>{const p=x.indexOf('=');return [x.slice(2,p),x.slice(p+1)];}));
function int(k,d,min,max){const n=Number(argv[k]??d);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`--${k}: ${min}..${max}`);return n;}
const sizes=(argv.sizes??'100,500,1000,5000,10000').split(',').map(Number);
if(!sizes.length||sizes.some(x=>!Number.isSafeInteger(x)||x<2||x>100000))throw Error('--sizes non valido');
const scenario=argv.scenario??'all';if(!['all','distribuito','concentrato','estremo'].includes(scenario))throw Error('--scenario non valido');
const scenarios=scenario==='all'?['distribuito','concentrato','estremo']:[scenario];
const seed=int('seed',20261014,1,2147483647),bucketMin=int('bucket',10,1,60),tolMin=int('tolerance',30,0,120);
const oracleMax=int('oracle-max',500,0,2000),maxMs=int('max-ms',15000,100,120000);
const maxChecks=int('max-checks',3000000,1000,200000000),maxHeapMB=int('max-heap-mb',700,32,16000);
const mutationPct=int('mutations-pct',10,0,50),auditMax=int('audit-max',1000,0,100000);
const min=60000,bucketMs=bucketMin*min,tolMs=tolMin*min,base=Date.UTC(2027,3,1,8,0);
const now=()=>performance.now(),heap=()=>process.memoryUsage().heapUsed/1048576;
const log=(event,details)=>console.log(JSON.stringify({event,...details}));
function rng(s){let x=s>>>0;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;};}
function fixture(n,mode){const r=rng((seed+n*31+{distribuito:1,concentrato:2,estremo:3}[mode])>>>0),out=[];
 const corridors=mode==='distribuito'?Math.max(16,Math.ceil(n/25)):mode==='concentrato'?2:1;
 const slots=mode==='distribuito'?144:mode==='concentrato'?12:1;
 for(let i=0;i<n;i++){const corridor=Math.floor(r()*corridors),start=mode==='estremo'?0:Math.floor(r()*(mode==='concentrato'?12:40));
  const length=mode==='estremo'?8:2+Math.floor(r()*6),time=base+Math.floor(r()*slots)*bucketMs;
  out.push({id:i+1,corridor,start,end:start+length,time,posti:1+Math.floor(r()*3)});
 }return out;
}
const segmentKey=(c,s)=>`${c}:${s}`;
const pixelKey=(c,s,b)=>`${c}:${s}:${b}`;
const signature=r=>`${r.corridor}:${r.start}:${r.end}:${r.time}`;
const covers=(a,r)=>a.corridor===r.corridor&&a.start<=r.start&&a.end>=r.end&&Math.abs(a.time+(r.start-a.start)*10*min-r.time)<=tolMs;
class PixelIndex{
 constructor(){this.pixels=new Map();this.groups=new Map();this.requests=new Map();this.reverse=new Map();this.postings=0;}
 keys(r){const out=[];for(let s=r.start;s<r.end;s++){const t=r.time+(s-r.start)*10*min;
  const lo=Math.floor((t-tolMs)/bucketMs)-1,hi=Math.floor((t+tolMs)/bucketMs)+1;
  for(let b=lo;b<=hi;b++)out.push(pixelKey(r.corridor,s,b));}return out;}
 add(r){if(this.requests.has(r.id))throw Error(`ID duplicato ${r.id}`);
  const sig=signature(r);let g=this.groups.get(sig);
  if(!g){g={shape:{...r},ids:new Map(),posti:0,keys:this.keys(r)};this.groups.set(sig,g);
   for(const k of g.keys){let p=this.pixels.get(k);if(!p){p=new Set();this.pixels.set(k,p);}p.add(sig);}}
  g.ids.set(r.id,r.posti);g.posti+=r.posti;this.requests.set(r.id,r);this.reverse.set(r.id,sig);this.postings+=g.keys.length;
 }
 remove(id){const r=this.requests.get(id);if(!r)return false;
  const sig=this.reverse.get(id),g=this.groups.get(sig);g.ids.delete(id);g.posti-=r.posti;
  this.requests.delete(id);this.reverse.delete(id);this.postings-=g.keys.length;
  if(!g.ids.size){for(const k of g.keys){const p=this.pixels.get(k);p.delete(sig);if(!p.size)this.pixels.delete(k);}this.groups.delete(sig);}return true;
 }
 update(r){this.remove(r.id);this.add(r);}
 query(anchor,stats){const seen=new Set();for(let s=anchor.start;s<anchor.end;s++){
  const t=anchor.time+(s-anchor.start)*10*min,k=pixelKey(anchor.corridor,s,Math.floor(t/bucketMs));
  stats.lookups++;const p=this.pixels.get(k);if(p)for(const sig of p){seen.add(sig);stats.groupPostings++;}
 }
 let count=0,posti=0;for(const sig of seen){stats.groupChecks++;const g=this.groups.get(sig);
  if(covers(anchor,g.shape)){count+=g.ids.size;posti+=g.posti;}}
 return {count,posti,groupCandidates:seen.size};
 }
 audit(){let postings=0,memberCount=0,posti=0;
  for(const [sig,g] of this.groups){if(!g.ids.size)throw Error('Gruppo vuoto');let groupPosti=0;
   for(const [id,p] of g.ids){const r=this.requests.get(id);if(!r||this.reverse.get(id)!==sig||r.posti!==p||signature(r)!==sig)throw Error('Reverse non coerente');groupPosti+=p;postings+=g.keys.length;memberCount++;}
   if(groupPosti!==g.posti)throw Error('Contatore posti errato');posti+=groupPosti;
   for(const k of g.keys)if(!this.pixels.get(k)?.has(sig))throw Error('Pixel mancante');
  }
  if(memberCount!==this.requests.size||postings!==this.postings||this.reverse.size!==this.requests.size)throw Error('Contatori globali errati');
  for(const [k,sigs] of this.pixels)for(const sig of sigs)if(!this.groups.get(sig)?.keys.includes(k))throw Error('Riferimento orfano');
  return {richieste:memberCount,posti,postings,gruppi:this.groups.size,pixels:this.pixels.size};
 }
}
function oracle(reqs,anchor){let count=0,posti=0;for(const r of reqs.values())if(covers(anchor,r)){count++;posti+=r.posti;}return {count,posti};}
function run(n,mode){if(global.gc)global.gc();const t0=now(),heap0=heap(),rs=fixture(n,mode),t1=now();
 const ix=new PixelIndex();for(const r of rs)ix.add(r);const t2=now();
 const random=rng((seed+n*17+77)>>>0);let added=0,updated=0,removed=0;
 const changes=Math.floor(n*mutationPct/100),mutationStart=now();
 for(let i=0;i<changes;i++){
  const id=1+Math.floor(random()*n),r=ix.requests.get(id);if(!r)continue;
  if(i%3===0){ix.remove(id);removed++;}
  else if(i%3===1){ix.update({...r,time:r.time+bucketMs,posti:r.posti+1});updated++;}
  else{const newid=n+i+1;ix.add({...r,id:newid,time:r.time+bucketMs});added++;}
 }
 const t3=now();let audit=null;if(n<=auditMax)audit=ix.audit();
 const stats={lookups:0,groupPostings:0,groupChecks:0},deadline=now()+maxMs;
 let anchors=0,covered=0,postiCovered=0,oracleCompared=0,oracleDiff=0,stopReason=null;
 const anchorList=rs;for(const a of anchorList){if(now()>deadline){stopReason='TIME_BUDGET';break;}
  if(heap()>maxHeapMB){stopReason='HEAP_BUDGET';break;}
  const found=ix.query(a,stats);covered+=found.count;postiCovered+=found.posti;anchors++;
  if(oracleMax>=n){const expected=oracle(ix.requests,a);oracleCompared++;if(expected.count!==found.count||expected.posti!==found.posti)oracleDiff++;}
  if(stats.groupChecks>maxChecks){stopReason='CHECK_BUDGET';break;}
 }
 const t4=now(),maxPixelGroups=Math.max(0,...ix.pixels.values().map(x=>x.size));
 log('SCALA',{scenario:mode,richiesteIniziali:n,richiesteAttive:ix.requests.size,completato:!stopReason,stopReason,ancoreAnalizzate:anchors,
  modifiche:{aggiunte:added,aggiornate:updated,rimosse:removed},pixel:ix.pixels.size,gruppi:ix.groups.size,
  presenzeRichieste:ix.postings,occupazioneMaxPixelGruppi:maxPixelGroups,
  lookupPixel:stats.lookups,postingsGruppiVisitati:stats.groupPostings,verificheGruppi:stats.groupChecks,
  richiesteCoperteTotali:covered,postiCopertiTotali:postiCovered,oracleAncore:oracleCompared,oracleDifferenze:oracleCompared?oracleDiff:null,
  audit,ms:{fixture:+(t1-t0).toFixed(2),indice:+(t2-t1).toFixed(2),mutazioni:+(t3-mutationStart).toFixed(2),query:+(t4-t3).toFixed(2),totale:+(t4-t0).toFixed(2)},
  heapPrimaMB:+heap0.toFixed(2),heapDopoMB:+heap().toFixed(2),rssMB:+(process.memoryUsage().rss/1048576).toFixed(2),
  nota:'Gruppi per firma identica: stessa tratta e stesso orario. Riferimenti ID conservati. Query su traiettorie-ancora, non missioni nuove.'});
 return !oracleDiff;
}
log('CONFIG',{sizes,scenarios,seed,bucketMin,tolMin,oracleMax,maxChecks,maxMs,maxHeapMB,mutationPct,auditMax,
 note:'Test sintetico offline: aggregazione SOLO di richieste con firma identica. Nessun I/O o modifica produzione.'});
let ok=true;for(const mode of scenarios)for(const n of sizes){try{if(!run(n,mode))ok=false;}catch(e){ok=false;log('ERRORE',{scenario:mode,richieste:n,messaggio:e.message,stack:e.stack});}}
log('FINE',{esito:ok?'COMPLETATO':'ERRORI',nota:'La parita oracle vale solo dove oracleAncore > 0; budget stop significa test parziale.'});if(!ok)process.exitCode=1;
