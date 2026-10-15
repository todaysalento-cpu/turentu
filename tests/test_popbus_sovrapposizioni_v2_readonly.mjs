// POPBUS V2 - test copertura formazioni su tratte sovrapposte, SOLA LETTURA.
// node --env-file=.env tests\test_popbus_sovrapposizioni_v2_readonly.mjs --live
// Opzioni: --ids=31,39,40 --max-routes=24 --timeout-ms=120000
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const LIVE=process.argv.includes('--live');
const arg=(key,def)=>{const v=process.argv.find(s=>s.startsWith(`--${key}=`));return v?v.slice(key.length+3):def};
const IDS=arg('ids','31,39,40').split(',').map(Number);
const MAX_ROUTES=Number(arg('max-routes','24'));
const TIMEOUT=Number(arg('timeout-ms','120000'));
const log=(event,data={})=>console.log(JSON.stringify({event,...data}));
const mod=p=>import(pathToFileURL(resolve(process.cwd(),p)).href);
const key=ids=>ids.map(Number).sort((a,b)=>a-b).join(',');
const reqIds=e=>(e?.requests||[]).map(r=>Number(r.id));
const unique=a=>[...new Set(a.map(Number))];
const permutations=a=>a.length===0?[[]]:a.flatMap((v,i)=>permutations(a.filter((_,j)=>j!==i)).map(rest=>[v,...rest]));
console.log('TURENTU POPBUS V2 - COPERTURA SOVRAPPOSIZIONI - SOLA LETTURA');
if(!LIVE){console.log('PREVIEW: nessun DB/routing. Eseguire con --live (Google Maps puo avere costi).');process.exit(0)}
if(!IDS.length||IDS.length>8||IDS.some(x=>!Number.isSafeInteger(x)||x<=0)||new Set(IDS).size!==IDS.length)throw Error('--ids: da 1 a 8 ID positivi distinti');
if(!Number.isSafeInteger(MAX_ROUTES)||MAX_ROUTES<1||MAX_ROUTES>100)throw Error('--max-routes deve essere 1..100');
if(!Number.isSafeInteger(TIMEOUT)||TIMEOUT<1000)throw Error('--timeout-ms non valido');
let pool,client;
const stats={richieste:0,nodi:0,candidateV2:0,pianiV2:0,formazioniV2:0,percorsiOracolo:0,gruppiOracolo:0,gruppiAssentiV2:0,nonConfrontabili:0,erroriRouting:0,routingLimitato:false};
const t0=Date.now();
try{
 ({pool}=await mod('db/db.js'));
 const {generaCandidate,generaFormazioniAlternative,valutaRichieste}=await mod('services/popbus/v2/model.js');
 const {pianifica}=await mod('services/popbus/v2/planner.js');
 client=await pool.connect();
 await client.query('BEGIN TRANSACTION READ ONLY');
 await client.query('SET LOCAL statement_timeout = 10000');
 const {rows:requests}=await client.query('SELECT * FROM richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id',[IDS]);
 stats.richieste=requests.length;
 const valid=requests.filter(r=>Number.isSafeInteger(Number(r.start_node_id))&&Number.isSafeInteger(Number(r.end_node_id))&&Number(r.start_node_id)!==Number(r.end_node_id)&&Number.isFinite(Date.parse(r.start_datetime))&&Number(r.posti_richiesti)>0&&Number.isFinite(Number(r.prezzo)));
 const nodeIds=unique(valid.flatMap(r=>[r.start_node_id,r.end_node_id]));
 const {rows:nodes}=await client.query('SELECT id,nome_nodo,ST_Y(posizione::geometry) AS lat,ST_X(posizione::geometry) AS lon FROM nodi_direttrice WHERE id=ANY($1::int[])',[nodeIds]);
 stats.nodi=nodes.length;
 log('INPUT',{richieste:requests.map(r=>({id:Number(r.id),origine:Number(r.start_node_id),destinazione:Number(r.end_node_id),partenza:r.start_datetime,posti:Number(r.posti_richiesti)})),richiesteValide:valid.length,nodi:nodeIds,nota:'La verifica pagamenti, capienza veicoli, turni ed economia NON e eseguita'});
 if(valid.length!==requests.length||requests.length!==IDS.length||nodes.length!==nodeIds.length)throw Error('Richieste mancanti/invalide o nodi mancanti');
 // Percorsi V2: solo quelli generati realmente, con planner e alternative del worker.
 const candidates=generaCandidate(valid,500);
 stats.candidateV2=candidates.length;
 const v2Groups=new Set();const v2Paths=[];
 const planCache=new Map();let calls=0;
 async function planFor(ids,classe='EXPRESS'){
   const k=ids.join('>');if(planCache.has(k))return planCache.get(k);
   if(calls>=MAX_ROUTES){stats.routingLimitato=true;return null}
   calls++;
   try{const plan=await pianifica({nodes:ids,seeds:[],classe},nodes);planCache.set(k,plan);return plan}
   catch(e){stats.erroriRouting++;log('ROUTE_ERROR',{nodes:ids,messaggio:e.message});planCache.set(k,null);return null}
 }
 for(const c of candidates){
   if(Date.now()-t0>TIMEOUT){stats.routingLimitato=true;break}
   const plan=await planFor(c.nodes,c.classe);if(!plan)continue;
   stats.pianiV2++;
   const forms=generaFormazioniAlternative(plan,valid,c.seeds,{maxFormazioni:80});
   const groups=forms.map(f=>key(reqIds(f)));
   groups.forEach(g=>v2Groups.add(g));stats.formazioniV2+=forms.length;
   v2Paths.push({nodes:plan.nodes,seeds:c.seeds,groups});
 }
 log('GENERATORE_V2',{candidate:candidates.map(c=>({nodes:c.nodes,seeds:c.seeds})),pianiValidi:stats.pianiV2,gruppi:[...v2Groups].sort(),dettaglio:v2Paths});
 // Oracolo limitato: per ogni coppia, enumeriamo soltanto gli ordinamenti dei suoi
 // endpoint (massimo 4 nodi). Verifichiamo con planner + model, non con tempi fittizi.
 // I percorsi che planner rifiuta NON vengono dichiarati fattibili.
 const oracleGroups=new Map();
 for(let i=0;i<valid.length;i++)for(let j=i+1;j<valid.length;j++){
   const pair=[valid[i],valid[j]];const endpoints=unique(pair.flatMap(r=>[r.start_node_id,r.end_node_id]));
   const wanted=key(pair.map(r=>r.id));let found=false,checked=0;
   for(const path of permutations(endpoints)){
     if(Date.now()-t0>TIMEOUT){stats.routingLimitato=true;break}
     if(!pair.every(r=>path.indexOf(Number(r.start_node_id))<path.indexOf(Number(r.end_node_id))))continue;
     const plan=await planFor(path);if(!plan)continue;
     checked++;stats.percorsiOracolo++;
     const evaluation=valutaRichieste(plan,pair,pair.map(r=>Number(r.id)),{mode:'seeds_only'});
     if(evaluation){found=true;if(!oracleGroups.has(wanted))oracleGroups.set(wanted,{ids:pair.map(r=>Number(r.id)),nodes:plan.nodes,peak:evaluation.peak,departure:new Date(evaluation.departure).toISOString()});}
   }
   if(!found && (stats.routingLimitato||checked===0))stats.nonConfrontabili++;
   log('COPPIA',{ids:pair.map(r=>Number(r.id)),pianiOracoloValidi:checked,oracoloAccetta:found,presenteNelleAlternativeV2:v2Groups.has(wanted),incompleto:stats.routingLimitato});
 }
 stats.gruppiOracolo=oracleGroups.size;
 const missing=[...oracleGroups.entries()].filter(([g])=>!v2Groups.has(g)).map(([,v])=>v);
 stats.gruppiAssentiV2=missing.length;
 log('GRUPPI_ORACOLO',{gruppi:[...oracleGroups.values()],assentiV2:missing});
 log('INTERPRETAZIONE',{messaggio:missing.length?'Possibile perdita di copertura V2: gruppo accettato su un piano ammissibile non presente nelle alternative generate.':'Nessuna perdita trovata nelle coppie esaminate (non dimostra copertura generale).',limite:'Oracolo su sole coppie; non include attivabilita veicoli e non confronta ancora il generatore pixel.'});
}catch(e){log('ERRORE',{messaggio:e.message,stack:e.stack?.split('\n').slice(0,3).join(' | ')});process.exitCode=1}
finally{if(client){try{await client.query('ROLLBACK')}catch(e){log('ROLLBACK_ERROR',{messaggio:e.message})}client.release()}if(pool)await pool.end();log('RIEPILOGO',{...stats,ms:Date.now()-t0,conclusivo:stats.percorsiOracolo>0&&!stats.routingLimitato})}
