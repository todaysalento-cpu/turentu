// POPBUS V2 - fixture A->C + B->D, nessuna scrittura DB.
// node --env-file=.env tests\test_popbus_fixture_parziale_readonly.mjs --list-nodes
// node --env-file=.env tests\test_popbus_fixture_parziale_readonly.mjs --live --nodes=1,2,3,4
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const arg=(k,d)=>process.argv.find(x=>x.startsWith(`--${k}=`))?.slice(k.length+3)??d;
const live=process.argv.includes('--live'), list=process.argv.includes('--list-nodes');
const ids=arg('nodes','').split(',').filter(Boolean).map(Number);
const log=(event,o={})=>console.log(JSON.stringify({event,...o}));
const mod=p=>import(pathToFileURL(resolve(process.cwd(),p)).href);
const group=e=>(e?.requests??[]).map(r=>Number(r.id)).sort((a,b)=>a-b).join(',');
console.log('TURENTU POPBUS V2 - FIXTURE SOVRAPPOSIZIONE PARZIALE - SOLA LETTURA');
if(!live&&!list){console.log('PREVIEW. Per elencare nodi: --list-nodes. Per test: --live --nodes=A,B,C,D');process.exit(0)}
if(live&&(ids.length!==4||new Set(ids).size!==4||ids.some(x=>!Number.isSafeInteger(x)||x<=0)))throw Error('Specificare quattro ID nodo distinti: --nodes=A,B,C,D');
let pool,client;
try{
 ({pool}=await mod('db/db.js'));
 client=await pool.connect();await client.query('BEGIN TRANSACTION READ ONLY');await client.query('SET LOCAL statement_timeout=10000');
 if(list){const {rows}=await client.query('SELECT id,nome_nodo,ST_Y(posizione::geometry) AS lat,ST_X(posizione::geometry) AS lon FROM nodi_direttrice ORDER BY id LIMIT 80');log('NODI_DISPONIBILI',{nodi:rows});process.exitCode=0;}
 else {
 const {generaCandidate,generaFormazioniAlternative,valutaRichieste,verificaQualitaRichieste}=await mod('services/popbus/v2/model.js');
 const {pianifica}=await mod('services/popbus/v2/planner.js');
 const {rows:nodes}=await client.query('SELECT id,nome_nodo,ST_Y(posizione::geometry) AS lat,ST_X(posizione::geometry) AS lon FROM nodi_direttrice WHERE id=ANY($1::int[])',[ids]);
 if(nodes.length!==4)throw Error('Uno o piu nodi non esistono');
 const [A,B,C,D]=ids;
 log('NODI',{ordine:ids,nodi:ids.map(id=>nodes.find(n=>Number(n.id)===id))});
 // La fixture e in memoria: orario B sincronizzato con il passaggio del mezzo da A a B.
 const oracle=await pianifica({nodes:ids,seeds:[],classe:'EXPRESS'},nodes);
 const idx=oracle.nodes.map(Number);const offsets=new Map(idx.map((n,i)=>[n,Number(oracle.cumulativeSeconds?.[i]??oracle.legs.slice(0,i).reduce((s,l)=>s+Number(l.seconds),0))]));
 if(![A,B,C,D].every(n=>offsets.has(n))||!(offsets.get(A)<offsets.get(B)&&offsets.get(B)<offsets.get(C)&&offsets.get(C)<offsets.get(D)))throw Error('Il planner non mantiene ordine A-B-C-D: scegliere nodi diversi');
 const departure=Date.parse(arg('departure','2026-11-15T10:00:00Z'));
 if(!Number.isFinite(departure))throw Error('--departure ISO non valido');
 const base={stato:'in_attesa',corsa_id:null,classe:'EXPRESS',posti_richiesti:1,prezzo:30};
 const req=[{...base,id:900001,start_node_id:A,end_node_id:C,start_datetime:new Date(departure+offsets.get(A)*1000)},
            {...base,id:900002,start_node_id:B,end_node_id:D,start_datetime:new Date(departure+offsets.get(B)*1000)}];
 const expected='900001,900002';
 const oracleEval=valutaRichieste(oracle,req,req.map(r=>r.id),{mode:'seeds_only'});
 const quality=verificaQualitaRichieste(oracle,req);
 log('FIXTURE',{richieste:req.map(r=>({id:r.id,origine:r.start_node_id,destinazione:r.end_node_id,partenza:r.start_datetime.toISOString(),posti:r.posti_richiesti})),percorsoOracolo:oracle.nodes,offsetSecondi:Object.fromEntries(offsets),qualita:quality,oracoloAccetta:Boolean(oracleEval),peak:oracleEval?.peak??null});
 const candidates=generaCandidate(req,500), groups=new Set(), details=[];
 for(const c of candidates){try{const p=await pianifica(c,nodes);const forms=generaFormazioniAlternative(p,req,c.seeds,{maxFormazioni:80});const gs=forms.map(group);gs.forEach(x=>groups.add(x));details.push({seeds:c.seeds,nodes:c.nodes,plannedNodes:p.nodes,formazioni:gs});}catch(e){details.push({seeds:c.seeds,nodes:c.nodes,errore:e.message})}}
 log('V2',{candidate:candidates.length,dettaglio:details,gruppi:[...groups].sort(),gruppoCondivisoPresente:groups.has(expected)});
 log('RIEPILOGO',{oracoloAccetta:Boolean(oracleEval),gruppoCondivisoPresenteV2:groups.has(expected),perditaCoperturaDimostrata:Boolean(oracleEval)&&!groups.has(expected),conclusivo:Boolean(oracleEval)&&details.every(d=>!d.errore),nota:'Fixture in memoria su nodi reali. Non testa pixel, pagamenti, capienza veicoli, turni, economia, andata/ritorno.'});
 }
}catch(e){log('ERRORE',{messaggio:e.message});process.exitCode=1}
finally{if(client){try{await client.query('ROLLBACK')}catch{}client.release()}if(pool)await pool.end()}
