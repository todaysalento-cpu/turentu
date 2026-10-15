// Diagnostica: scoperta automatica del corridoio da coordinate dei nodi e richieste.
// Nessun percorso guida in input. Fixture in memoria, DB in sola lettura.
// Esecuzione: node --env-file=.env tests\test_popbus_pixel_autonomo_readonly.mjs --live --ids=13,10,11,12
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
const arg=(name,fallback)=>process.argv.find(x=>x.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const live=process.argv.includes('--live');
const ids=arg('ids','13,10,11,12').split(',').map(Number);
const toleranceMin=30;
const maxRoutes=Number(arg('max-routes','12'));
const log=(event,data={})=>console.log(JSON.stringify({event,...data}));
const load=p=>import(pathToFileURL(resolve(process.cwd(),p)).href);
const groupKey=xs=>[...xs].map(Number).sort((a,b)=>a-b).join(',');
console.log('TURENTU POPBUS - PIXEL AUTONOMO vs V2 - SOLA LETTURA');
if(!live){console.log('PREVIEW: --live --ids=13,10,11,12 [--max-routes=12]');process.exit(0)}
if(ids.length!==4||ids.some(x=>!Number.isSafeInteger(x)||x<=0)||new Set(ids).size!==4)throw Error('Sono richiesti quattro ID distinti');
if(!Number.isSafeInteger(maxRoutes)||maxRoutes<1||maxRoutes>24)throw Error('max-routes deve essere 1..24');
let pool,client;
try{
 ({pool}=await load('db/db.js'));
 client=await pool.connect();
 await client.query('BEGIN READ ONLY');
 await client.query('SET LOCAL statement_timeout=10000');
 const {rows}=await client.query('SELECT id, ST_Y(posizione::geometry)::float8 AS lat, ST_X(posizione::geometry)::float8 AS lon FROM nodi_direttrice WHERE id=ANY($1::int[])',[ids]);
 if(rows.length!==4||rows.some(r=>!Number.isFinite(r.lat)||!Number.isFinite(r.lon)))throw Error('Nodi assenti o coordinate non valide');
 const byId=new Map(rows.map(r=>[Number(r.id),r]));
 const {generaCandidate,generaFormazioniAlternative,valutaRichieste,verificaQualitaRichieste}=await load('services/popbus/v2/model.js');
 const {pianifica}=await load('services/popbus/v2/planner.js');
 // Fixture nota, ma nessuna sequenza guida: soltanto O/D e orari delle richieste.
 const base={stato:'in_attesa',corsa_id:null,classe:'EXPRESS',posti_richiesti:1,prezzo:30};
 const requests=[
  {...base,id:900001,start_node_id:13,end_node_id:11,start_datetime:new Date('2026-11-15T10:00:00.000Z')},
  {...base,id:900002,start_node_id:10,end_node_id:12,start_datetime:new Date('2026-11-15T10:31:14.000Z')}
 ];
 if(requests.some(r=>!byId.has(r.start_node_id)||!byId.has(r.end_node_id)))throw Error('La fixture richiede i nodi 13,10,11,12 (in qualsiasi ordine)');
 const t0=performance.now();
 // Coordinate metriche locali; PCA 2D ricava la direttrice principale senza usare l'ordine degli ID.
 const lat0=rows.reduce((s,r)=>s+r.lat,0)/rows.length*Math.PI/180;
 const points=rows.map(r=>({id:Number(r.id),x:r.lon*111320*Math.cos(lat0),y:r.lat*110540}));
 const mx=points.reduce((s,p)=>s+p.x,0)/4,my=points.reduce((s,p)=>s+p.y,0)/4;
 let xx=0,xy=0,yy=0;
 for(const p of points){const x=p.x-mx,y=p.y-my;xx+=x*x;xy+=x*y;yy+=y*y}
 const theta=0.5*Math.atan2(2*xy,xx-yy),vx=Math.cos(theta),vy=Math.sin(theta);
 const ordered=points.map(p=>({...p,s:(p.x-mx)*vx+(p.y-my)*vy,lateral:Math.abs(-(p.x-mx)*vy+(p.y-my)*vx)})).sort((a,b)=>a.s-b.s);
 // Orientamento dal segno della richiesta 900001; senza guide o percorsi inseriti manualmente.
 const pos=new Map(ordered.map((p,i)=>[p.id,i]));
 if(pos.get(requests[0].start_node_id)>pos.get(requests[0].end_node_id))ordered.reverse();
 const position=new Map(ordered.map((p,i)=>[p.id,i]));
 const validDirection=requests.every(r=>position.get(r.start_node_id)<position.get(r.end_node_id));
 const maxLateral=Math.max(...ordered.map(p=>p.lateral));
 // Pixel spaziali: segmenti consecutivi dell'asse scoperto; indice invertito di richieste.
 const pixelIndex=new Map();
 for(const r of requests){
  const a=position.get(r.start_node_id),b=position.get(r.end_node_id);
  if(a>=b)continue;
  for(let i=a;i<b;i++){
   const key=`${ordered[i].id}>${ordered[i+1].id}`;
   if(!pixelIndex.has(key))pixelIndex.set(key,new Set());
   pixelIndex.get(key).add(r.id);
  }
 }
 const pairs=new Set();
 for(const occupants of pixelIndex.values()){
  const list=[...occupants];
  for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++)pairs.add(groupKey([list[i],list[j]]));
 }
 // Prefiltro temporale conservativo: distanza rettilinea / 25 km/h, margine 30 min + 2 h.
 // Non certifica compatibilita': la decisione finale spetta al valutatore V2 su routing reale.
 const generated=[];
 for(const pair of pairs){
  const selected=pair.split(',').map(Number).map(id=>requests.find(r=>r.id===id));
  const lo=Math.min(...selected.map(r=>position.get(r.start_node_id)));
  const hi=Math.max(...selected.map(r=>position.get(r.end_node_id)));
  const seq=ordered.slice(lo,hi+1).map(p=>p.id);
  const departures=selected.map(r=>r.start_datetime.getTime());
  if(Math.max(...departures)-Math.min(...departures)> (120+2*toleranceMin)*60000)continue;
  generated.push({nodes:seq,seeds:selected.map(r=>r.id),classe:'EXPRESS'});
 }
 const t1=performance.now();
 const v2Candidates=generaCandidate(requests,500);
 const v2Groups=new Set(),v2Details=[];
 for(const c of v2Candidates){
  try{const p=await pianifica(c,rows);const formations=generaFormazioniAlternative(p,requests,c.seeds,{maxFormazioni:80});const groups=formations.map(f=>groupKey((f.requests??[]).map(r=>r.id)));groups.forEach(g=>v2Groups.add(g));v2Details.push({nodes:c.nodes,seeds:c.seeds,groups})}
  catch(e){v2Details.push({nodes:c.nodes,seeds:c.seeds,error:e.message})}
 }
 const t2=performance.now();
 const pixelGroups=new Set(),pixelDetails=[];
 for(const c of generated.slice(0,maxRoutes)){
  try{const p=await pianifica(c,rows);const evaluation=valutaRichieste(p,requests,c.seeds,{mode:'seeds_only'});const quality=verificaQualitaRichieste(p,requests);const accepted=Boolean(evaluation)&&quality.ok===true;if(accepted)pixelGroups.add(groupKey(c.seeds));pixelDetails.push({nodes:c.nodes,plannedNodes:p.nodes,seeds:c.seeds,accepted,peak:evaluation?.peak??null,quality:quality.ok})}
  catch(e){pixelDetails.push({nodes:c.nodes,seeds:c.seeds,error:e.message})}
 }
 const t3=performance.now();
 const missing=[...pixelGroups].filter(k=>!v2Groups.has(k));
 const incomplete=generated.length>maxRoutes||v2Details.some(x=>x.error)||pixelDetails.some(x=>x.error);
 log('INPUT',{nodes:rows,requests:requests.map(r=>({id:r.id,from:r.start_node_id,to:r.end_node_id,departure:r.start_datetime.toISOString()}))});
 log('SCOPERTA_AUTONOMA',{metodo:'PCA_COORDINATE_E_INDICE_SEGMENTI',orderedNodes:ordered.map(p=>p.id),maxLateralMetres:Math.round(maxLateral),validDirection,pixelKeys:pixelIndex.size,pairs:[...pairs],candidates:generated.map(c=>({nodes:c.nodes,seeds:c.seeds})),nota:'Non usa percorso guida, ma lavora su un insieme di 4 nodi prefiltrati. Non e un generatore pixel spazio-temporale generale.'});
 log('V2',{candidates:v2Candidates.length,groups:[...v2Groups],details:v2Details});
 log('PIXEL_AUTONOMO',{acceptedGroups:[...pixelGroups],details:pixelDetails});
 log('RIEPILOGO',{recuperoSenzaGuida:missing.includes('900001,900002'),missingInV2:missing,incompleto:incomplete,ms:{discovery:Math.round(t1-t0),v2:Math.round(t2-t1),pixelValidation:Math.round(t3-t2)},limits:'Fixture fissa con nodi reali, PCA su 4 nodi, indice di segmenti senza bucket temporali esatti. Non prova completezza o scalabilita. Non verifica capienza veicoli, economia, avvicinamento o ritorno.'});
}catch(e){log('ERRORE',{message:e.message,stack:arg('debug','false')==='true'?e.stack:undefined});process.exitCode=1}
finally{if(client){try{await client.query('ROLLBACK')}catch{}client.release()}if(pool)await pool.end()}
