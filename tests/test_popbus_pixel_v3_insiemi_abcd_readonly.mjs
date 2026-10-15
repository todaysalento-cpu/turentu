/**
 * TURENTU POPBUS — PIXEL V3 ↔ SPAZIO/TRAIETTORIE/TEMPO/INSIEMI A-B-C-D
 * Diagnostica sintetica OFFLINE, senza DB, routing, worker o scritture.
 * PIXEL e' solo un filtro conservativo: la compatibilita' esatta resta all'oracolo.
 * Confronta per ogni traiettoria i seed ID ammissibili e gli insiemi temporali.
 * Opzionale: importa generaCandidate dal model.js locale per classificare i seed V2.
 * Non certifica fattibilita' stradale, capienza, economia, ritorno o matching produttivo.
 */
import {performance} from 'node:perf_hooks';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const arg=Object.fromEntries(process.argv.slice(2).filter(x=>x.startsWith('--')&&x.includes('=')).map(x=>{const p=x.indexOf('=');return [x.slice(2,p),x.slice(p+1)];}));
function integer(k,d,lo,hi){const v=Number(arg[k]??d);if(!Number.isSafeInteger(v)||v<lo||v>hi)throw Error(`--${k} richiede intero ${lo}..${hi}`);return v;}
const sizes=(arg.sizes??'30,100,200,500').split(',').map(Number);
if(!sizes.length||sizes.some(x=>!Number.isSafeInteger(x)||x<2||x>5000))throw Error('--sizes: interi 2..5000');
const seed=integer('seed',20261014,1,2147483647), tol=integer('tolerance',30,0,120),bucket=integer('bucket',10,1,60),edge=integer('edge-min',10,1,60),maxMs=integer('max-ms',15000,100,120000),maxGroups=integer('max-groups',200000,100,2000000),maxV2=integer('max-v2',500,0,5000);
const modes=arg.scenario==='all'||!arg.scenario?['fixture','distribuito','concentrato','estremo','confini']:arg.scenario.split(',');
if(modes.some(m=>!['fixture','distribuito','concentrato','estremo','confini'].includes(m)))throw Error('--scenario non valido');
const MIN=60000, BASE=Date.UTC(2027,3,1), nId=(c,p)=>c*1000+p+1,nPos=id=>(id-1)%1000,corridor=id=>Math.floor((id-1)/1000);
const signature=r=>`${corridor(r.start_node_id)}:${nPos(r.start_node_id)}:${nPos(r.end_node_id)}:${Date.parse(r.start_datetime)}`;
const rng=s=>()=>((s=Math.imul(s,1664525)+1013904223>>>0)/4294967296);
const log=(event,x)=>console.log(JSON.stringify({event,...x}));
function req(id,c,s,e,t){return {id,start_node_id:nId(c,s),end_node_id:nId(c,e),start_datetime:new Date(BASE+t*MIN).toISOString(),classe:'STANDARD'};}
function make(n,mode){if(mode==='fixture')return [req(1,0,0,2,540),req(2,0,1,3,552),req(3,0,3,4,574),req(4,0,1,2,660),req(5,0,0,4,541)];
 const r=rng((seed+n*11+({distribuito:1,concentrato:7,estremo:11,confini:17}[mode]||0))>>>0),out=[];
 for(let i=0;i<n;i++){const c=mode==='distribuito'?Math.floor(r()*Math.max(10,Math.ceil(n/14))):mode==='concentrato'?i%3:0;
 const s=mode==='estremo'?0:Math.floor(r()*(mode==='concentrato'?14:mode==='confini'?5:22));
 const len=mode==='estremo'?8:1+Math.floor(r()*(mode==='concentrato'?6:4));
 let t=mode==='estremo'?540:mode==='concentrato'?540+Math.floor(r()*100):420+Math.floor(r()*720);
 if(mode==='confini')t=540+(i%7)*bucket+(i%3===0?tol:i%3===1?-tol:0)+(i%2?1:-1);
 out.push(req(i+1,c,s,s+len,t));}return out;
}
function trajectories(reqs){const by=new Map(),trs=new Map();function add(c,s,e){if(s<e)trs.set(`${c}:${s}:${e}`,{c,s,e,key:`${c}:${s}:${e}`});}
 for(const r of reqs){const c=corridor(r.start_node_id),s=nPos(r.start_node_id),e=nPos(r.end_node_id);if(c!==corridor(r.end_node_id)||e<=s)throw Error('Tratta invalida');add(c,s,e);if(!by.has(c))by.set(c,[]);by.get(c).push({s,e});}
 for(const [c,intervals] of by){intervals.sort((a,b)=>a.s-b.s||a.e-b.e);let s=null,e=null;for(const p of intervals){if(s===null){s=p.s;e=p.e;}else if(p.s<=e)e=Math.max(e,p.e);else{add(c,s,e);s=p.s;e=p.e;}}if(s!==null)add(c,s,e);}
 return [...trs.values()];}
function contained(tr,r){return tr.c===corridor(r.start_node_id)&&tr.c===corridor(r.end_node_id)&&nPos(r.start_node_id)>=tr.s&&nPos(r.end_node_id)<=tr.e;}
function nominal(tr,r){return Date.parse(r.start_datetime)/MIN-(nPos(r.start_node_id)-tr.s)*edge;}
function intersect(tr,ids,byId){let lo=-Infinity,hi=Infinity;for(const id of ids){const r=byId.get(id);if(!r||!contained(tr,r))return null;const t=nominal(tr,r);lo=Math.max(lo,t-tol);hi=Math.min(hi,t+tol);}return lo<=hi?{lo,hi}:null;}
// Indice compatto: per ogni segmento attraversato, solo il bucket nominale del passaggio.
class Pixel{constructor(){this.cells=new Map();this.byId=new Map();}
 add(r){this.byId.set(r.id,r);const c=corridor(r.start_node_id),s=nPos(r.start_node_id),e=nPos(r.end_node_id),start=Date.parse(r.start_datetime)/MIN;
 for(let p=s;p<e;p++){const b=Math.floor((start+(p-s)*edge)/bucket),k=`${c}:${p}:${b}`;if(!this.cells.has(k))this.cells.set(k,new Set());this.cells.get(k).add(r.id);}}
 // Recupero conservativo su un segmento della traiettoria: tutte le richieste
 // che attraversano il segmento, nella finestra temporale del passaggio.
 querySegment(c,p,t,stats){const out=new Set();const lo=Math.floor((t-2*tol)/bucket)-1,hi=Math.floor((t+2*tol)/bucket)+1;
 for(let b=lo;b<=hi;b++){stats.lookups++;for(const id of this.cells.get(`${c}:${p}:${b}`)||[]){stats.postings++;out.add(id);}}return out;}
 // Cerca candidati rispetto a una richiesta ancora, includendo ogni richiesta
 // con almeno un segmento condiviso e tempi di passaggio compatibili.
 queryAnchor(r,stats){const c=corridor(r.start_node_id),s=nPos(r.start_node_id),e=nPos(r.end_node_id),t=Date.parse(r.start_datetime)/MIN,out=new Set();
 for(let p=s;p<e;p++)for(const id of this.querySegment(c,p,t+(p-s)*edge,stats))out.add(id);return out;}
}
function groupsFor(tr,requests,limit){const events=[];for(const r of requests){if(!contained(tr,r))continue;const t=nominal(tr,r);events.push({t:t-tol,id:r.id,delta:1},{t:t+tol,id:r.id,delta:-1});}
 events.sort((a,b)=>a.t-b.t||b.delta-a.delta);const active=new Set(),groups=new Map();for(let i=0;i<events.length;){const t=events[i].t;while(i<events.length&&events[i].t===t){const ev=events[i++];if(ev.delta>0)active.add(ev.id);else active.delete(ev.id);}
 if(i<events.length&&events[i].t>t&&active.size>=2){const ids=[...active].sort((a,b)=>a-b),key=ids.join(',');if(!groups.has(key))groups.set(key,ids);if(groups.size>limit)throw Error('GROUP_BUDGET');}}
 return groups;}
// Per ogni traiettoria, PIXEL deve includere tutti i potenziali membri
// di un insieme: usa un anchor per ogni richiesta coperta dalla traiettoria.
function pixelPool(tr,all,index,stats){const result=new Set();const anchors=all.filter(r=>contained(tr,r));let missingPairs=0,checkedPairs=0,sequentialPairs=0,sequentialMisses=0;const pairExamples=[];
 const candidates=new Map();for(const r of anchors)candidates.set(r.id,index.queryAnchor(r,stats));
 for(let i=0;i<anchors.length;i++)for(let j=i+1;j<anchors.length;j++){
  const a=anchors[i],b=anchors[j];if(!intersect(tr,[a.id,b.id],index.byId))continue;
  const overlaps=Math.max(nPos(a.start_node_id),nPos(b.start_node_id))<Math.min(nPos(a.end_node_id),nPos(b.end_node_id));if(overlaps)checkedPairs++;else sequentialPairs++;const ab=candidates.get(a.id).has(b.id),ba=candidates.get(b.id).has(a.id);
  if(!ab||!ba){if(overlaps)missingPairs++;else sequentialMisses++;if(pairExamples.length<5)pairExamples.push({ids:[a.id,b.id],ab,ba});}
 }
 for(const r of anchors){result.add(r.id);for(const id of candidates.get(r.id))result.add(id);}
 return {pool:[...result].map(id=>index.byId.get(id)).filter(r=>r&&contained(tr,r)),missingPairs,checkedPairs,sequentialPairs,sequentialMisses,pairExamples};}
function compare(tr,all,index,stats,limit){const baseline=groupsFor(tr,all,limit),pixel=pixelPool(tr,all,index,stats),pool=pixel.pool,filtered=groupsFor(tr,pool,limit);
 const missing=[];for(const [key,ids] of baseline)if(!filtered.has(key)){if(missing.length<5)missing.push(ids);}
 const extra=[];for(const [key,ids] of filtered)if(!baseline.has(key)){if(extra.length<5)extra.push(ids);}
 return {baseline:baseline.size,filtered:filtered.size,missing,extra,pool:pool.length,missingPairs:pixel.missingPairs,checkedPairs:pixel.checkedPairs,sequentialPairs:pixel.sequentialPairs,sequentialMisses:pixel.sequentialMisses,pairExamples:pixel.pairExamples,baselineGroups:baseline};}
async function loadV2(){const p=resolve(process.cwd(),'services/popbus/v2/model.js');if(!existsSync(p))return {status:'non_trovato'};try{const m=await import(pathToFileURL(p).href);return typeof m.generaCandidate==='function'?{status:'ok',fn:m.generaCandidate}:{status:'export_assente'};}catch(e){return {status:'errore_import',message:e.message};}}
const v2=await loadV2();log('CONFIG',{sizes,modes,tol,bucket,edge,maxMs,maxGroups,maxV2,v2:v2.status,note:'Diagnostica sintetica offline. I candidati V2 sono letti soltanto se il modulo locale e importabile.'});
let failures=0;
for(const mode of modes)for(const n of mode==='fixture'?[5]:sizes){const t0=performance.now();try{const all=make(n,mode),tr=trajectories(all),index=new Pixel();for(const r of all)index.add(r);
 const stats={lookups:0,postings:0},byId=new Map(all.map(r=>[r.id,r]));let totalBaseline=0,totalFiltered=0,missing=0,extra=0,missingPairs=0,checkedPairs=0,sequentialPairs=0,sequentialMisses=0,poolMembers=0,checked=0;const examples=[];const groupByTr=new Map();
 for(const trajectory of tr){if(performance.now()-t0>maxMs)throw Error('TIME_BUDGET');const x=compare(trajectory,all,index,stats,maxGroups);checked++;totalBaseline+=x.baseline;totalFiltered+=x.filtered;poolMembers+=x.pool;missingPairs+=x.missingPairs;checkedPairs+=x.checkedPairs;sequentialPairs+=x.sequentialPairs;sequentialMisses+=x.sequentialMisses;sequentialPairs+=x.sequentialPairs;sequentialMisses+=x.sequentialMisses;missing+=x.missing.length;extra+=x.extra.length;groupByTr.set(trajectory.key,x.baselineGroups);if((x.missing.length||x.extra.length)&&examples.length<5)examples.push({tr:trajectory.key,missing:x.missing,extra:x.extra});}
 let v2info={status:'saltato'};if(v2.fn&&all.length<=maxV2){try{const candidates=v2.fn(all,10000),categories={A:0,B:0,C:0,D:0,INVALIDO:0},samples=[];
 for(const candidate of candidates){const ids=[...new Set((candidate.seeds||[]).map(Number))],rs=ids.map(id=>byId.get(id));let category='INVALIDO';if(rs.every(Boolean)){if(ids.length===1)category='D';else{const possible=tr.filter(t=>rs.every(r=>contained(t,r)));if(!possible.length)category='A';else{const feasible=possible.filter(t=>intersect(t,ids,byId));if(!feasible.length)category='B';else category=feasible.some(t=>[...(groupByTr.get(t.key)?.values()||[])].some(group=>ids.every(id=>group.includes(id))))?'D':'C';}}}
 categories[category]++;if(category!=='D'&&samples.length<5)samples.push({ids,category});}
 v2info={status:'ok',candidates:candidates.length,categories,samples};}catch(e){v2info={status:'errore_v2',message:e.message};}}
 const success=missing===0&&extra===0&&missingPairs===0;log('RISULTATO',{scenario:mode,richieste:all.length,trajectories:tr.length,pixels:index.cells.size,trajectoriesChecked:checked,insiemiOracle:totalBaseline,insiemiPixel:totalFiltered,insiemiMancanti:missing,insiemiExtra:extra,coppieCompatibiliOracle:checkedPairs,coppieCompatibiliPerseDaPixel:missingPairs,coppieSequenziali:sequentialPairs,coppieSequenzialiNonRecuperate:sequentialMisses,poolMembers,pixelLookups:stats.lookups,pixelPostings:stats.postings,ms:+(performance.now()-t0).toFixed(2),v2:v2info,examples,esito:success?'OK':'DIFF'});if(!success)failures++;
 }catch(e){failures++;log('ERRORE',{scenario:mode,richieste:n,message:e.message});}}
log('FINE',{esito:failures?'ERRORI':'COMPLETATO',failures,note:'La verifica discriminante e la copertura delle coppie sovrapposte; il confronto gruppi e solo un controllo di coerenza (il pool include le ancore). Le coppie sequenziali richiedono altro recupero.'});if(failures)process.exitCode=1;
