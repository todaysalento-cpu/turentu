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
console.log('TURENTU POPBUS - DIAGNOSTICA ORDINE PIXEL - SOLA LETTURA');
if(!live){console.log('PREVIEW: --live --sizes=20,50,100 --sample=8 --offset=0 --seed=20261014 --probe=0');process.exit(0)}
const sample=Number(opt('sample','8'));
const offset=Number(opt('offset','0'));
const probe=Number(opt('probe','0'));
if(!sizes.length||sizes.some(n=>!Number.isSafeInteger(n)||n<2||n>500)||![sample,offset,probe,seed].every(Number.isSafeInteger)||sample<1||sample>40||offset<0||probe<0||probe>8)throw Error('Parametri non validi');
const pairKind=(a,b,pos)=>{
 const s1=pos.get(a.start_node_id)?.i,e1=pos.get(a.end_node_id)?.i;
 const s2=pos.get(b.start_node_id)?.i,e2=pos.get(b.end_node_id)?.i;
 if([s1,e1,s2,e2].some(x=>x===undefined))return 'NODI_NON_INDICIZZATI';
 if(s1===s2&&e1===e2)return 'IDENTICHE';
 if(s1<=s2&&e1>=e2||s2<=s1&&e2>=e1)return 'CONTENIMENTO';
 return 'SOVRAPPOSIZIONE_PARZIALE';
};
const assess=(candidate,byId,group)=>{
 const nodeIds=candidate.nodes,duplicates=nodeIds.filter((n,i)=>nodeIds.indexOf(n)!==i);
 const positions=new Map(group.nodes.map((n,i)=>[n.id,i]));
 const req=candidate.seeds.map(id=>byId.get(id));
 const stops=req.flatMap(r=>r?[r.start_node_id,r.end_node_id]:[]);
 const absent=[...new Set(stops)].filter(id=>!nodeIds.includes(id));
 const outOfOrder=req.filter(r=>r&&nodeIds.indexOf(r.start_node_id)>=nodeIds.indexOf(r.end_node_id)).map(r=>r.id);
 const latlon=new Map(group.nodes.map(n=>[n.id,n]));
 const legKm=nodeIds.slice(1).map((id,i)=>Number(dist(latlon.get(nodeIds[i]),latlon.get(id)).toFixed(3)));
 const straightKm=Number(dist(latlon.get(nodeIds[0]),latlon.get(nodeIds.at(-1))).toFixed(3));
 const sumKm=Number(legKm.reduce((s,x)=>s+x,0).toFixed(3));
 const p=nodeIds.map(id=>positions.get(id));
 const decreasing=p.some((x,i)=>i>0&&x<=p[i-1]);
 return {duplicateNodes:[...new Set(duplicates)],missingCommercialNodes:absent,requestReversals:outOfOrder,pcaPositions:p,pcaDecreasing:decreasing,legAirKm:legKm,sumAirKm:sumKm,directAirKm:straightKm,airDetourRatio:straightKm>0?Number((sumKm/straightKm).toFixed(3)):null};
};
// Diagnostica esplicativa dei seed, indipendente da modifiche al model.
function diagnoseSeeds(plan, seedRequests, verificaQualitaRichieste) {
 const index=new Map(plan.nodes.map((id,i)=>[Number(id),i]));
 const times=[0];for(const leg of plan.legs)times.push(times.at(-1)+Number(leg.seconds)*1000);
 const tol=30*60000, rows=[];let lo=-Infinity,hi=Infinity;
 for(const r of seedRequests){
  const s=index.get(Number(r.start_node_id)),e=index.get(Number(r.end_node_id));
  const date=new Date(r.start_datetime).getTime(),posti=Number(r.posti_richiesti),prezzo=Number(r.prezzo);
  const reasons=[];
  if(s==null||e==null||s>=e)reasons.push('TRATTA_NON_PRESENTE');
  if(!Number.isFinite(date))reasons.push('DATA_NON_VALIDA');
  if(!Number.isInteger(posti)||posti<=0)reasons.push('POSTI_NON_VALIDI');
  if(r.prezzo==null||!Number.isFinite(prezzo)||prezzo<0)reasons.push('PREZZO_NON_VALIDO');
  if(s!=null&&e!=null&&s<e&&plan.legs.slice(s,e).every(l=>l.roadCoincident===true))reasons.push('TRATTA_ZERO');
  let window=null;
  if(s!=null&&Number.isFinite(date)){
   const center=date-times[s];const lower=center-tol,upper=center+tol;
   window={lower:new Date(lower).toISOString(),upper:new Date(upper).toISOString(),offsetToPickupMin:Number((times[s]/60000).toFixed(2))};
   lo=Math.max(lo,lower);hi=Math.min(hi,upper);
  }
  rows.push({id:Number(r.id),from:r.start_node_id,to:r.end_node_id,reasons,window});
 }
 const qualitySingles=seedRequests.map(r=>({id:Number(r.id),...verificaQualitaRichieste(plan,[r])}));
 const qualityTogether=verificaQualitaRichieste(plan,seedRequests);
 return {seeds:rows,temporalOverlap:lo<=hi,temporalGapMin:lo>hi?Number(((lo-hi)/60000).toFixed(2)):0,qualitySingles,qualityTogether};
}
let pool,client;
try{
 ({pool}=await load('db/db.js'));client=await pool.connect();await client.query('BEGIN READ ONLY');await client.query('SET LOCAL statement_timeout=10000');
 const {rows}=await client.query('SELECT id, ST_Y(posizione::geometry)::float8 AS lat, ST_X(posizione::geometry)::float8 AS lon FROM nodi_direttrice WHERE posizione IS NOT NULL ORDER BY id LIMIT 500');
 const nodes=rows.map(r=>({...r,id:Number(r.id)})).filter(r=>Number.isFinite(r.lat)&&Number.isFinite(r.lon));
 const groups=corridors(nodes);
 log('CORRIDOI',{components:groups.map((g,i)=>({id:i,ordered:g.nodes.map(n=>n.id),maxLateralKm:g.maxLateralKm??null,usable:g.usable}))});
 const {pianifica}=await load('services/popbus/v2/planner.js');
 const {valutaRichieste,verificaQualitaRichieste}=await load('services/popbus/v2/model.js');
 for(const size of sizes){
  const req=fixture(size,groups,seed),found=discover(req,groups),byId=new Map(req.map(r=>[r.id,r]));
  const pos=new Map();groups.forEach((g,c)=>g.nodes.forEach((n,i)=>pos.set(n.id,{c,i})));
  const selected=found.pairs.slice(offset,offset+sample);
  let valid=0,failed=0,accepted=0,probeUsed=0;
  for(let ix=0;ix<selected.length;ix++){
   const candidate=selected[ix];const a=byId.get(candidate.seeds[0]),b=byId.get(candidate.seeds[1]);
   const corridor=groups[pos.get(a.start_node_id).c];
   const metrics=assess(candidate,byId,corridor);
   const startA=a.start_datetime.getTime(),startB=b.start_datetime.getTime();
   const detail={index:offset+ix,seeds:candidate.seeds,requests:[a,b].map(r=>({id:r.id,from:r.start_node_id,to:r.end_node_id,departure:r.start_datetime.toISOString()})),kind:pairKind(a,b,pos),candidateNodes:candidate.nodes,metrics,departureDeltaMin:Number((Math.abs(startA-startB)/60000).toFixed(2))};
   try{
    const p=await pianifica(candidate,nodes);
    valid++;
    let evaluation=null,quality=null;
    try{const e=valutaRichieste(p,req,candidate.seeds,{mode:'seeds_only'});evaluation={accepted:!!e,peak:e?.peak??null,diagnosi:diagnoseSeeds(p,[a,b],verificaQualitaRichieste)};if(e){const selectedReq=e.requests.map(x=>byId.get(Number(x.id))).filter(Boolean);quality=verificaQualitaRichieste(p,selectedReq);if(quality.ok)accepted++}}
    catch(e){evaluation={error:e.message}}
    log('CANDIDATA',{...detail,status:'PIANO_VALIDO',plannedNodes:p.nodes,mandatoryNodes:p.mandatoryNodes,evaluation,qualityOk:quality?.ok??null});
   }catch(e){
    failed++;
    const msg=String(e.message||e);
    let probeResult=null;
    // Diagnostica opzionale: ogni tratta singola, senza alterare l'ordine o sostituire la candidata.
    // Al massimo --probe tratte globalmente per scala: chiamate Google Maps aggiuntive.
    if(probe>probeUsed){
      const legs=candidate.nodes.slice(1).map((to,i)=>[candidate.nodes[i],to]);
      probeResult=[];
      for(const [from,to] of legs.slice(0,probe-probeUsed)){
       probeUsed++;
       try{const p=await pianifica({nodes:[from,to],seeds:[],classe:'EXPRESS'},nodes);probeResult.push({from,to,ok:true,plannedNodes:p.nodes,actualMetres:p.actualMetres})}
       catch(err){probeResult.push({from,to,ok:false,error:err.message})}
      }
    }
    log('CANDIDATA',{...detail,status:'ERRORE_PIANO',error:msg,diagnosi:metrics.duplicateNodes.length?'NODI_DUPLICATI':metrics.missingCommercialNodes.length?'NODI_COMMERCIALI_MANCANTI':metrics.requestReversals.length?'RICHIESTA_INVERTITA':msg.includes('Ordine nodi obbligatori')?'PROIEZIONE_ROUTING_O_ORDINE_GEOMETRICO': 'ALTRO_ERRORE',probeResult});
   }
  }
  log('SCALA',{size,totalPairs:found.pairs.length,offset,examined:selected.length,valid,failed,accepted,unexamined:found.pairs.length-selected.length,probeLegs:probeUsed,nota:'Nessun errore attribuito con certezza alla PCA senza verificare la geometria restituita dal provider. Campione deterministico; --offset cambia la finestra.'});
 }
 log('FINE',{db:'ROLLBACK READ ONLY',warning:'Routing Google Maps puo avere costi. Non modifica worker, richieste o database. Non certifica pixel generale o attivabilita.'});
}catch(e){log('ERRORE',{message:e.message});process.exitCode=1}
finally{if(client){try{await client.query('ROLLBACK')}catch{}client.release()}if(pool)await pool.end()}
