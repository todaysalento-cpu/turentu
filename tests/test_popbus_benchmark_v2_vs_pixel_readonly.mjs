/**
 * TURENTU POPBUS — benchmark V2 vs PIXEL (offline, read-only)
 * Importa generaCandidate reale da services/popbus/v2/model.js.
 * Misura: V2 puro, V2 su componenti esatte del grafo dei nodi,
 * e query PIXEL spaziali/temporali (NON usate per tagliare V2).
 * Non chiama database, worker, routing o servizi.
 * Non confonde indicizzazione PIXEL con equivalenza funzionale V2.
 */
import {performance} from 'node:perf_hooks';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const args=Object.fromEntries(process.argv.slice(2).filter(s=>s.startsWith('--')&&s.includes('=')).map(s=>{const i=s.indexOf('=');return [s.slice(2,i),s.slice(i+1)];}));
const sizes=(args.sizes||'30,100,200,500').split(',').map(Number);
const modes=(args.scenario||'all')==='all'?['distribuito','concentrato','estremo','confini']:(args.scenario||'distribuito').split(',');
const cap=Number(args['max-candidates']||10000), tol=Number(args.tol||30), bucket=Number(args.bucket||10), repeats=Number(args.repeats||3);
if(sizes.some(n=>!Number.isSafeInteger(n)||n<2||n>5000)||modes.some(x=>!['distribuito','concentrato','estremo','confini'].includes(x))||![cap,tol,bucket,repeats].every(Number.isFinite)||cap<1||bucket<1||repeats<1||repeats>20)throw Error('Argomenti non validi');
const modPath=resolve(process.cwd(),args.model||'services/popbus/v2/model.js');
if(!existsSync(modPath))throw Error(`model.js non trovato: ${modPath}. Avvia dalla root del backend o usa --model=...`);
const {generaCandidate}=await import(pathToFileURL(modPath).href);
if(typeof generaCandidate!=='function')throw Error('generaCandidate non esportata');
const nId=(c,p)=>c*1000+p+1, MIN=60000, BASE=Date.UTC(2027,3,1);
const rnd=s=>()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);
const mk=(n,mode)=>{const r=rnd(20261014+n*11+({distribuito:1,concentrato:7,estremo:11,confini:17}[mode]||0)),out=[];
 for(let i=0;i<n;i++){const c=mode==='distribuito'?Math.floor(r()*Math.max(10,Math.ceil(n/14))):mode==='concentrato'?i%3:0;
 const s=mode==='estremo'?0:Math.floor(r()*(mode==='concentrato'?14:mode==='confini'?5:22));
 const len=mode==='estremo'?8:1+Math.floor(r()*(mode==='concentrato'?6:4));
 let t=mode==='estremo'?540:mode==='concentrato'?540+Math.floor(r()*100):420+Math.floor(r()*720);
 if(mode==='confini')t=540+(i%7)*bucket+(i%3===0?tol:i%3===1?-tol:0)+(i%2?1:-1);
 out.push({id:i+1,start_node_id:nId(c,s),end_node_id:nId(c,s+len),start_datetime:new Date(BASE+t*MIN).toISOString(),classe:'STANDARD'});}
 return out;};
function components(rs){
 const parent=new Map();
 function root(x){if(!parent.has(x))parent.set(x,x);if(parent.get(x)!==x)parent.set(x,root(parent.get(x)));return parent.get(x);}
 for(const r of rs){const a=root(r.start_node_id),b=root(r.end_node_id);if(a!==b)parent.set(a,b);}
 const groups=new Map();for(const r of rs){const k=root(r.start_node_id);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
 return [...groups.values()];
}
function candidateKey(c){return `${c.classe}|${c.nodes.join(':')}|${[...new Set(c.seeds.map(Number))].sort((a,b)=>a-b).join(',')}`;}
function timed(fn){const t=performance.now();try{return {ok:true,value:fn(),ms:performance.now()-t};}catch(e){return {ok:false,error:e.message,ms:performance.now()-t};}}
function pixelBuild(rs){const map=new Map();for(const r of rs){const s=(r.start_node_id-1)%1000,e=(r.end_node_id-1)%1000,c=Math.floor((r.start_node_id-1)/1000),t=Date.parse(r.start_datetime)/MIN;
 for(let p=s;p<e;p++){const b=Math.floor((t+(p-s)*10)/bucket),key=`${c}:${p}:${b}`;if(!map.has(key))map.set(key,[]);map.get(key).push(r.id);}}
 return map;}
function pixelQueries(rs,index){let lookups=0,postings=0;const all=new Set();for(const r of rs){const s=(r.start_node_id-1)%1000,e=(r.end_node_id-1)%1000,c=Math.floor((r.start_node_id-1)/1000),t=Date.parse(r.start_datetime)/MIN;
 for(let p=s;p<e;p++){const tm=t+(p-s)*10;for(let b=Math.floor((tm-2*tol)/bucket)-1;b<=Math.floor((tm+2*tol)/bucket)+1;b++){lookups++;const ids=index.get(`${c}:${p}:${b}`)||[];postings+=ids.length;for(const id of ids)all.add(id);}}}
 return {lookups,postings,idsRecuperati:all.size};}
function median(a){const x=[...a].sort((a,b)=>a-b);return x[Math.floor(x.length/2)];}
const log=(event,data)=>console.log(JSON.stringify({event,...data}));
log('CONFIG',{sizes,modes,cap,tol,bucket,repeats,model:modPath,note:'Il filtro per componenti e esatto per concatenazione V2. PIXEL e misurato separatamente, non sostituisce generaCandidate.'});
let differences=0;
for(const mode of modes)for(const n of sizes){
 const rs=mk(n,mode),comp=components(rs),full=[],split=[],pixel=[];
 for(let k=0;k<repeats;k++){
  const f=timed(()=>generaCandidate(rs,cap));full.push(f);
  const s=timed(()=>comp.flatMap(g=>generaCandidate(g,cap)));split.push(s);
  const p=timed(()=>{const ix=pixelBuild(rs);return {cells:ix.size,...pixelQueries(rs,ix)};});pixel.push(p);
 }
 const a=full.at(-1),b=split.at(-1),q=pixel.at(-1);
 let parity='NON_VERIFICABILE',missing=null,extra=null;
 if(a.ok&&b.ok){const ka=new Set(a.value.map(candidateKey)),kb=new Set(b.value.map(candidateKey));missing=[...ka].filter(k=>!kb.has(k)).length;extra=[...kb].filter(k=>!ka.has(k)).length;parity=missing===0&&extra===0?'OK':'DIFF';if(parity==='DIFF')differences++;}
 log('RISULTATO',{scenario:mode,richieste:n,componenti:comp.length,dimensioneMassimaComponente:Math.max(...comp.map(g=>g.length)),
 v2:{status:a.ok?'ok':'limite_o_errore',candidati:a.ok?a.value.length:null,errore:a.error||null,msMediana:+median(full.map(x=>x.ms)).toFixed(3)},
 v2Componenti:{status:b.ok?'ok':'limite_o_errore',candidati:b.ok?b.value.length:null,errore:b.error||null,msMediana:+median(split.map(x=>x.ms)).toFixed(3)},
 pixelSoloIndice:{cells:q.value?.cells??null,lookups:q.value?.lookups??null,postings:q.value?.postings??null,idsRecuperati:q.value?.idsRecuperati??null,msMediana:+median(pixel.map(x=>x.ms)).toFixed(3)},
 paritaCandidate:parity,mancanti:missing,extra,
 nota:!a.ok?'V2 puro non completato: impossibile attestare parita':!b.ok?'V2 per componenti non completato':'Parita verificata su chiave classe|nodi|seed'});
}
log('FINE',{esito:differences?'DIFFERENZE':'COMPLETATO',differenze:differences,note:'Non attribuire a PIXEL il guadagno di V2 per componenti: e un pre-filtro grafo separato.'});
if(differences)process.exitCode=1;
