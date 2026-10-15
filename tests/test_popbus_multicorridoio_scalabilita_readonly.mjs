// Turentu POPBUS: benchmark diagnostico multi-corridoio, solo lettura.
// Non certifica completezza, attivabilita o parita' economica.
// Esempio: node --env-file=.env tests\test_popbus_multicorridoio_scalabilita_readonly.mjs --live --sizes=20,50,100 --routes=8
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
const opt=(k,d)=>process.argv.find(a=>a.startsWith(`--${k}=`))?.slice(k.length+3)??d;
const live=process.argv.includes('--live');
const sizes=opt('sizes','20,50,100').split(',').map(Number);
const routeLimit=Number(opt('routes','8'));
const v2Limit=Number(opt('v2-routes','8'));
const seed=Number(opt('seed','20261014'));
const log=(event,data={})=>console.log(JSON.stringify({event,...data}));
const load=p=>import(pathToFileURL(resolve(process.cwd(),p)).href);
const key=ids=>[...ids].map(Number).sort((a,b)=>a-b).join(',');
const dist=(a,b)=>{const lat=(a.lat+b.lat)/2*Math.PI/180;return Math.hypot((a.lat-b.lat)*110.54,(a.lon-b.lon)*111.32*Math.cos(lat))};
const rng=(s)=>()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296};
function corridors(nodes){
 const groups=[],unseen=new Set(nodes.map(n=>n.id)),byId=new Map(nodes.map(n=>[n.id,n]));
 while(unseen.size){const start=unseen.values().next().value;unseen.delete(start);const q=[start],comp=[];
  while(q.length){const id=q.pop(),n=byId.get(id);comp.push(n);for(const other of [...unseen])if(dist(n,byId.get(other))<=45){unseen.delete(other);q.push(other)}}
  if(comp.length<3){groups.push({nodes:comp,usable:false});continue}
  const lat0=comp.reduce((s,n)=>s+n.lat,0)/comp.length*Math.PI/180;
  const pts=comp.map(n=>({...n,x:n.lon*111.32*Math.cos(lat0),y:n.lat*110.54}));
  const mx=pts.reduce((s,p)=>s+p.x,0)/pts.length,my=pts.reduce((s,p)=>s+p.y,0)/pts.length;
  let xx=0,xy=0,yy=0;for(const p of pts){const x=p.x-mx,y=p.y-my;xx+=x*x;xy+=x*y;yy+=y*y}
  const theta=Math.atan2(2*xy,xx-yy)/2,vx=Math.cos(theta),vy=Math.sin(theta);
  const ordered=pts.map(p=>({...p,s:(p.x-mx)*vx+(p.y-my)*vy,lateral:Math.abs(-(p.x-mx)*vy+(p.y-my)*vx)})).sort((a,b)=>a.s-b.s);
  groups.push({nodes:ordered,usable:true,maxLateralKm:Math.max(...ordered.map(n=>n.lateral))});
 }
 return groups.sort((a,b)=>b.nodes.length-a.nodes.length);
}
function fixture(n,groups,s){
 const rand=rng(s),usable=groups.filter(g=>g.usable&&g.nodes.length>=4);if(!usable.length)throw Error('Nessun corridoio con almeno 4 nodi');
 const base=Date.parse('2026-11-15T10:00:00Z'),out=[];
 for(let z=0;z<n;z++){
  const g=usable[Math.floor(rand()*usable.length)],len=g.nodes.length;
  const i=Math.floor(rand()*(len-2)),j=i+1+Math.floor(rand()*(len-i-1));
  // Sincronizzazione approssimata su progressiva geografica, NON tempi routing reali.
  const km=Math.abs(g.nodes[i].s-g.nodes[0].s),offset=Math.round(km/65*3600);
  const jitter=Math.round((rand()-.5)*50*60),wave=Math.floor(z/12)*4*3600;
  out.push({id:900000+z+1,start_node_id:g.nodes[i].id,end_node_id:g.nodes[j].id,start_datetime:new Date(base+(offset+jitter+wave)*1000),posti_richiesti:1,prezzo:30,classe:'EXPRESS',stato:'in_attesa',corsa_id:null,_corridor:groups.indexOf(g)});
 }
 return out;
}
function discover(req,groups){
 const pos=new Map(),pixels=new Map();let entries=0;
 for(let c=0;c<groups.length;c++)if(groups[c].usable)groups[c].nodes.forEach((p,i)=>pos.set(p.id,{c,i}));
 for(const r of req){const a=pos.get(r.start_node_id),b=pos.get(r.end_node_id);if(!a||!b||a.c!==b.c||a.i>=b.i)continue;
  for(let i=a.i;i<b.i;i++){const k=`${a.c}:${i}`;if(!pixels.has(k))pixels.set(k,[]);pixels.get(k).push(r);entries++}
 }
 const pairs=new Map();let comparisons=0;
 for(const list of pixels.values())for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
  comparisons++;const a=list[i],b=list[j],k=key([a.id,b.id]);if(pairs.has(k))continue;
  const pa=pos.get(a.start_node_id),pb=pos.get(b.start_node_id),c=groups[pa.c].nodes;
  const departureA=a.start_datetime.getTime()-Math.round((c[pa.i].s-c[0].s)/65*3600000);
  const departureB=b.start_datetime.getTime()-Math.round((c[pb.i].s-c[0].s)/65*3600000);
  if(Math.abs(departureA-departureB)>60*60000)continue;
  const lo=Math.min(pa.i,pb.i),hi=Math.max(pos.get(a.end_node_id).i,pos.get(b.end_node_id).i);
  pairs.set(k,{nodes:c.slice(lo,hi+1).map(p=>p.id),seeds:[a.id,b.id],classe:'EXPRESS'});
 }
 return {pairs:[...pairs.values()],pixels:pixels.size,entries,comparisons};
}
console.log('TURENTU POPBUS - MULTICORRIDOIO / SCALABILITA - SOLA LETTURA');
if(!live){console.log('PREVIEW: --live --sizes=20,50,100 --routes=8 --v2-routes=8 --seed=20261014');process.exit(0)}
if(!sizes.length||sizes.some(n=>!Number.isSafeInteger(n)||n<2||n>500)||!Number.isSafeInteger(routeLimit)||routeLimit<0||routeLimit>30||!Number.isSafeInteger(v2Limit)||v2Limit<0||v2Limit>30||!Number.isSafeInteger(seed))throw Error('Parametri non validi');
let pool,client;
try{
 ({pool}=await load('db/db.js'));client=await pool.connect();await client.query('BEGIN READ ONLY');await client.query('SET LOCAL statement_timeout=10000');
 const {rows}=await client.query('SELECT id, ST_Y(posizione::geometry)::float8 AS lat, ST_X(posizione::geometry)::float8 AS lon FROM nodi_direttrice WHERE posizione IS NOT NULL ORDER BY id LIMIT 500');
 const nodes=rows.map(r=>({...r,id:Number(r.id)})).filter(r=>Number.isFinite(r.lat)&&Number.isFinite(r.lon));
 const groups=corridors(nodes);
 log('CORRIDOI',{nodiLetti:nodes.length,componenti:groups.map((g,i)=>({id:i,nodi:g.nodes.map(n=>n.id),usabile:g.usable,maxLateralKm:g.maxLateralKm??null})),avvertenza:'Cluster per vicinanza <=45 km e ordinamento PCA: euristica, non rete stradale o direttrici certificate.'});
 const {generaCandidate,generaFormazioniAlternative,valutaRichieste,verificaQualitaRichieste}=await load('services/popbus/v2/model.js');
 const {pianifica}=await load('services/popbus/v2/planner.js');
 for(const size of sizes){
  const req=fixture(size,groups,seed);const t0=performance.now();const found=discover(req,groups),t1=performance.now();
  let v2=[],v2Error=null;try{v2=generaCandidate(req,500)}catch(e){v2Error=e.message}
  const t2=performance.now();
  const byId=new Map(req.map(r=>[r.id,r]));const usedNodes=[...new Set(req.flatMap(r=>[r.start_node_id,r.end_node_id]).concat(found.pairs.slice(0,routeLimit).flatMap(c=>c.nodes)))].map(id=>nodes.find(n=>n.id===id)).filter(Boolean);
  const v2Groups=new Set(),v2Errors=[],pixelGroups=new Set(),pixelErrors=[];
  for(const c of v2.slice(0,v2Limit))try{const p=await pianifica(c,usedNodes);const forms=generaFormazioniAlternative(p,req,c.seeds,{maxFormazioni:80});for(const f of forms){const ids=(f.requests??[]).map(r=>r.id);if(ids.length>=2)v2Groups.add(key(ids))}}catch(e){v2Errors.push({seeds:c.seeds,error:e.message})}
  const t3=performance.now();
  for(const c of found.pairs.slice(0,routeLimit))try{const p=await pianifica(c,usedNodes);const evalResult=valutaRichieste(p,req,c.seeds,{mode:'seeds_only'});const quality=verificaQualitaRichieste(p,req);if(evalResult&&quality.ok===true)pixelGroups.add(key(c.seeds))}catch(e){pixelErrors.push({seeds:c.seeds,error:e.message})}
  const t4=performance.now();
  const missing=[...pixelGroups].filter(k=>!v2Groups.has(k));
  const exhaustiveV2=!v2Error&&v2.length<=v2Limit&&v2Errors.length===0;
  const exhaustivePixel=found.pairs.length<=routeLimit&&pixelErrors.length===0;
  log('SCALA',{richieste:size,seed,discovery:{pixelKeys:found.pixels,pixelEntries:found.entries,confrontiPixel:found.comparisons,coppieCandidate:found.pairs.length},v2:{candidate:v2.length,erroreGenerazione:v2Error,routeEsaminate:Math.min(v2.length,v2Limit),gruppiMultipliOsservati:v2Groups.size,errori:v2Errors},pixel:{routeEsaminate:Math.min(found.pairs.length,routeLimit),gruppiAccettati:[...pixelGroups],errori:pixelErrors},confronto:{gruppiPixelNonOsservatiV2:missing,perditaV2DimostrataNelCampione:exhaustiveV2&&missing.length>0,esaustivoV2:exhaustiveV2,esaustivoPixel:exhaustivePixel},ms:{discovery:Math.round(t1-t0),generaV2:Math.round(t2-t1),routingV2:Math.round(t3-t2),routingPixel:Math.round(t4-t3)},nota:'Solo coppie e campioni limitati; la mancanza in V2 NON e un falso negativo dimostrato se esaustivoV2=false. Nessuna verifica economica o ritorno.'});
 }
 log('FINE',{db:'ROLLBACK READ ONLY',limiti:'Richieste sintetiche, cluster geografici euristici, confronto routing campionato, possibile costo Google Maps; non certifica completezza, pixel generale o attivabilita.'});
}catch(e){log('ERRORE',{messaggio:e.message});process.exitCode=1}finally{if(client){try{await client.query('ROLLBACK')}catch{}client.release()}if(pool)await pool.end()}
