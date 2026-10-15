// POPBUS - confronto V2 vs prototipo pixel su fixture A->C + B->D.
// DB READ ONLY; richieste simulate in memoria; routing Google potenzialmente a pagamento.
// node --env-file=.env tests\test_popbus_pixel_fixture_reale_readonly.mjs --live --nodes=13,10,11,12
// Non e' il modulo pixel di produzione: prototipo controllato su una direttrice ordinata fornita esplicitamente.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const opt=(k,d)=>process.argv.find(x=>x.startsWith(`--${k}=`))?.slice(k.length+3)??d;
const live=process.argv.includes('--live');
const ids=opt('nodes','13,10,11,12').split(',').map(Number);
const bucketMin=Number(opt('bucket-min','10'));
const tolMin=Number(opt('tolerance-min','30'));
const departure=Date.parse(opt('departure','2026-11-15T10:00:00Z'));
const log=(event,data={})=>console.log(JSON.stringify({event,...data}));
const load=p=>import(pathToFileURL(resolve(process.cwd(),p)).href);
const key=arr=>[...arr].sort((a,b)=>a-b).join(',');
const bucket=t=>Math.floor(t/(bucketMin*60000));
console.log('TURENTU POPBUS - PIXEL vs V2 - FIXTURE REALE - SOLA LETTURA');
if(!live){console.log('PREVIEW: --live --nodes=13,10,11,12 [--bucket-min=10] [--tolerance-min=30]');process.exit(0)}
if(ids.length!==4||new Set(ids).size!==4||ids.some(x=>!Number.isSafeInteger(x)||x<=0))throw Error('Servono quattro nodi distinti');
if(!Number.isInteger(bucketMin)||bucketMin<1||bucketMin>60||!Number.isInteger(tolMin)||tolMin!==30||!Number.isFinite(departure))throw Error('Parametri non validi: tolleranza V2 = 30 minuti');
let pool,client;
try{
 ({pool}=await load('db/db.js'));
 client=await pool.connect();
 await client.query('BEGIN TRANSACTION READ ONLY');
 await client.query('SET LOCAL statement_timeout=10000');
 const {rows:nodes}=await client.query('SELECT id,nome_nodo,ST_Y(posizione::geometry) AS lat,ST_X(posizione::geometry) AS lon FROM nodi_direttrice WHERE id=ANY($1::int[])',[ids]);
 if(nodes.length!==4)throw Error('Nodi mancanti nel DB');
 const {generaCandidate,generaFormazioniAlternative,valutaRichieste,verificaQualitaRichieste}=await load('services/popbus/v2/model.js');
 const {pianifica}=await load('services/popbus/v2/planner.js');
 const [A,B,C,D]=ids;
 const t0=performance.now();
 // Il percorso guida e' un input controllato della fixture, non una direttrice scoperta autonomamente.
 const guide=await pianifica({nodes:ids,seeds:[],classe:'EXPRESS'},nodes);
 const route=guide.nodes.map(Number);
 const offset=new Map(route.map((n,i)=>[n,Number(guide.cumulativeSeconds?.[i]??guide.legs.slice(0,i).reduce((s,l)=>s+Number(l.seconds),0))]));
 if(!ids.every((n,i)=>route[i]===n)||!ids.every((n,i)=>i===0||offset.get(ids[i])>offset.get(ids[i-1])))throw Error('Planner non preserva ordine dei quattro nodi');
 const base={stato:'in_attesa',corsa_id:null,classe:'EXPRESS',posti_richiesti:1,prezzo:30};
 const requests=[{...base,id:900001,start_node_id:A,end_node_id:C,start_datetime:new Date(departure)},
 {...base,id:900002,start_node_id:B,end_node_id:D,start_datetime:new Date(departure+offset.get(B)*1000)}];
 const intervals=requests.map(r=>({...r,lo:route.indexOf(r.start_node_id),hi:route.indexOf(r.end_node_id)}));
 const t1=performance.now();
 // Pixel spazio-temporali: ogni richiesta proietta i suoi segmenti sul corridoio ordinato
 // in tutti i bucket ammessi dalla tolleranza. Il passaggio esatto usa i secondi reali.
 const index=new Map();let pixelEntries=0;
 for(const r of intervals){
  for(let i=r.lo;i<r.hi;i++){
   const at=r.start_datetime.getTime()+(offset.get(route[i])-offset.get(r.start_node_id))*1000;
   const low=bucket(at-tolMin*60000)-1,high=bucket(at+tolMin*60000)+1;
   for(let b=low;b<=high;b++){
    const k=`${route[i]}>${route[i+1]}@${b}`;
    if(!index.has(k))index.set(k,new Set());index.get(k).add(r.id);pixelEntries++;
   }
  }
 }
 const pairs=new Set();let pixelLookups=0;
 for(const r of intervals){
  const neighbours=new Set();
  for(let i=r.lo;i<r.hi;i++){
   const at=r.start_datetime.getTime()+(offset.get(route[i])-offset.get(r.start_node_id))*1000;
   for(let b=bucket(at-tolMin*60000)-1;b<=bucket(at+tolMin*60000)+1;b++){
    pixelLookups++;for(const other of index.get(`${route[i]}>${route[i+1]}@${b}`)??[])if(other!==r.id)neighbours.add(other);
   }
  }
  for(const other of neighbours)pairs.add(key([r.id,other]));
 }
 const pixelCandidates=[];const rejected=[];
 for(const pair of pairs){
  const selected=pair.split(',').map(Number).map(id=>intervals.find(r=>r.id===id));
  const lo=Math.min(...selected.map(r=>r.lo)),hi=Math.max(...selected.map(r=>r.hi));
  const candidateNodes=route.slice(lo,hi+1);
  // Compatibilita' esatta delle finestre di partenza sul percorso guida.
  const windows=selected.map(r=>{
   const center=r.start_datetime.getTime()-(offset.get(r.start_node_id)-offset.get(route[lo]))*1000;
   return [center-tolMin*60000,center+tolMin*60000];
  });
  const earliest=Math.max(...windows.map(w=>w[0])),latest=Math.min(...windows.map(w=>w[1]));
  if(earliest>latest){rejected.push({pair,reason:'FINSTRE_NON_INTERSECATE'});continue}
  pixelCandidates.push({nodes:candidateNodes,seeds:selected.map(r=>r.id),classe:'EXPRESS',pair});
 }
 const t2=performance.now();
 const v2c=generaCandidate(requests,500);const v2Groups=new Set(),v2Detail=[];
 for(const c of v2c){try{
  const p=await pianifica(c,nodes);
  const f=generaFormazioniAlternative(p,requests,c.seeds,{maxFormazioni:80});
  const groups=f.map(x=>key((x.requests??[]).map(r=>Number(r.id))));groups.forEach(g=>v2Groups.add(g));
  v2Detail.push({nodes:c.nodes,seeds:c.seeds,groups});
 }catch(e){v2Detail.push({nodes:c.nodes,seeds:c.seeds,error:e.message})}}
 const t3=performance.now();
 const pixelAccepted=new Set(),pixelDetail=[];
 for(const c of pixelCandidates){try{
  const p=await pianifica(c,nodes);
  const evaluation=valutaRichieste(p,requests,c.seeds,{mode:'seeds_only'});
  const quality=verificaQualitaRichieste(p,requests);
  const accepted=Boolean(evaluation)&&quality.ok===true;
  if(accepted)pixelAccepted.add(c.pair);
  pixelDetail.push({nodes:c.nodes,seeds:c.seeds,plannedNodes:p.nodes,accepted,peak:evaluation?.peak??null,quality:quality.ok,reason:accepted?null:'VALUTAZIONE_O_QUALITA_RESPINTA'});
 }catch(e){pixelDetail.push({nodes:c.nodes,seeds:c.seeds,error:e.message})}}
 const t4=performance.now();
 const oracleEval=valutaRichieste(guide,requests,requests.map(r=>r.id),{mode:'seeds_only'});
 const oracleQuality=verificaQualitaRichieste(guide,requests);
 const oracleAccepted=Boolean(oracleEval)&&oracleQuality.ok===true;
 const missingV2=[...pixelAccepted].filter(g=>!v2Groups.has(g));
 log('FIXTURE',{nodes:ids,requests:requests.map(r=>({id:r.id,from:r.start_node_id,to:r.end_node_id,time:r.start_datetime.toISOString()})),guide:guide.nodes,offsetSeconds:Object.fromEntries(offset),oracleAccepted,oraclePeak:oracleEval?.peak??null,oracleQuality:oracleQuality.ok});
 log('PIXEL',{tipo:'PROTOTIPO_CORRIDOIO_GUIDATO_NON_MODULO_PRODUZIONE',bucketMin,tolMin,pixelKeys:index.size,pixelEntries,pixelLookups,pairs:[...pairs],rejected,candidates:pixelCandidates.length,detail:pixelDetail,acceptedGroups:[...pixelAccepted]});
 log('V2',{candidates:v2c.length,detail:v2Detail,groups:[...v2Groups].sort()});
 log('RIEPILOGO',{oracleAccepted,pixelRecovered:[...pixelAccepted],missingInV2:missingV2,recuperoFixtureDimostrato:oracleAccepted&&missingV2.includes('900001,900002'),incompleto:v2Detail.some(x=>x.error)||pixelDetail.some(x=>x.error),ms:{routingGuide:Math.round(t1-t0),indexAndGeneration:Math.round(t2-t1),v2:Math.round(t3-t2),pixelValidation:Math.round(t4-t3)},limits:'Prototipo su corridoio ordinato fornito come input, NON matching pixel generale. Non verifica attivazione, flotta, economia, ritorno. Chiamate Google Maps possibili.'});
}catch(e){log('ERRORE',{message:e.message,stack:opt('debug','false')==='true'?e.stack:undefined});process.exitCode=1}
finally{if(client){try{await client.query('ROLLBACK')}catch{}client.release()}if(pool)await pool.end()}
