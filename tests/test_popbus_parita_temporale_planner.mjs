/**
 * TURENTU POPBUS — test di parità del prefiltro temporale contro model.valutaRichieste.
 * SOLA LETTURA. Non importa planner.js, non chiama routing, DB o worker.
 * Usa plan.nodes e plan.legs reali (o fixture incorporata), e non confonde
 * un'esclusione del planner per qualità/capacità con un'esclusione temporale.
 *
 * node tests/test_popbus_parita_temporale_planner.mjs
 * node tests/test_popbus_parita_temporale_planner.mjs tests/piani_popbus.json
 *
 * JSON: {"cases":[{"name":"...","plan":{"nodes":[1,2,3],
 * "legs":[{"seconds":180,"metres":2000},{"seconds":420,"metres":5000}]},
 * "requests":[{"id":1,"start_node_id":1,"end_node_id":2,
 * "start_datetime":"2027-04-01T09:00:00.000Z","posti_richiesti":1,
 * "prezzo":10,"classe_percorrenza":"BASSA"}],
 * "seeds":[1],"maxPeak":20}]}
 * I casi con geometria reale devono contenere le legs prodotte dal planner.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const tolerance = 30 * 60_000;
const min = 60_000;
function date(m) { return new Date(Date.UTC(2027,3,1,9,0)+m*min).toISOString(); }
function r(id,s,e,t) { return {id,start_node_id:s,end_node_id:e,start_datetime:date(t),posti_richiesti:1,prezzo:12,classe_percorrenza:'BASSA'}; }
function fixture() {
  return { cases: [
    {name:'sovrapposte_compatibili',plan:{nodes:[1,2,3,4],legs:[{seconds:180,metres:3000},{seconds:480,metres:8000},{seconds:120,metres:2000}]},requests:[r(1,1,3,0),r(2,2,4,8)],seeds:[1,2]},
    {name:'sequential_compatibili',plan:{nodes:[1,2,3],legs:[{seconds:600,metres:10000},{seconds:120,metres:2000}]},requests:[r(1,1,2,0),r(2,2,3,10)],seeds:[1,2]},
    {name:'temporale_incompatibile',plan:{nodes:[1,2,3],legs:[{seconds:600,metres:10000},{seconds:120,metres:2000}]},requests:[r(1,1,2,0),r(2,2,3,100)],seeds:[1,2]},
    {name:'falso_negativo_sintetico',plan:{nodes:[1,2,3],legs:[{seconds:60,metres:1000},{seconds:60,metres:1000}]},requests:[r(1,1,2,0),r(2,2,3,61)],seeds:[1,2]},
    {name:'tratta_invertita',plan:{nodes:[1,2,3],legs:[{seconds:600,metres:10000},{seconds:120,metres:2000}]},requests:[r(1,3,2,0)],seeds:[1]},
    {name:'capacita_insufficiente',plan:{nodes:[1,2,3],legs:[{seconds:600,metres:10000},{seconds:120,metres:2000}]},requests:[r(1,1,3,0),r(2,1,3,0)],seeds:[1,2],maxPeak:1}
  ]};
}
function prefiltro(plan, requests, seeds, synthetic=false) {
  if (!Array.isArray(plan?.nodes) || !Array.isArray(plan?.legs) || plan.legs.length!==plan.nodes.length-1 || plan.nodes.length<2) return {ok:false,reason:'PIANO_INVALIDO'};
  const idx = new Map(plan.nodes.map((x,i)=>[Number(x),i]));
  if(idx.size!==plan.nodes.length)return {ok:false,reason:'NODI_RIPETUTI'};
  const offsets=[0];
  for(const leg of plan.legs) {
    const sec=synthetic?600:Number(leg.seconds);
    if(!Number.isFinite(sec)||sec<0)return {ok:false,reason:'TEMPI_INVALIDI'};
    offsets.push(offsets.at(-1)+sec*1000);
  }
  const byId=new Map(requests.map(x=>[Number(x.id),x]));
  let lower=-Infinity,upper=Infinity;
  for(const id of [...new Set(seeds.map(Number))]) {
    const req=byId.get(id);
    if(!req)return {ok:false,reason:'RICHIESTA_ASSENTE'};
    const s=idx.get(Number(req.start_node_id)),e=idx.get(Number(req.end_node_id));
    if(s==null||e==null||s>=e)return {ok:false,reason:'TRATTA_NON_PRESENTE'};
    const t=Date.parse(req.start_datetime);
    if(!Number.isFinite(t))return {ok:false,reason:'DATA_NON_VALIDA'};
    const nominal=t-offsets[s];
    lower=Math.max(lower,nominal-tolerance);
    upper=Math.min(upper,nominal+tolerance);
  }
  return {ok:lower<=upper,reason:lower<=upper?'COMPATIBILE':'TEMPO_INCOMPATIBILE',margine_min:Number(((upper-lower)/min).toFixed(3)),intervallo_partenza:lower<=upper?[new Date(lower).toISOString(),new Date(upper).toISOString()]:null};
}
async function main(){
  const paths=[resolve(process.cwd(),'services/popbus/v2/model.js'),resolve(process.cwd(),'../services/popbus/v2/model.js'),resolve(process.cwd(),'../../services/popbus/v2/model.js')];
  const modelPath=paths.find(existsSync);
  if(!modelPath)throw Error('model.js non trovato. Esegui dalla root del progetto o dalla cartella tests.');
  const model=await import(pathToFileURL(modelPath).href);
  if(typeof model.valutaRichieste!=='function')throw Error('model.js non esporta valutaRichieste');
  const data=process.argv[2]?JSON.parse(readFileSync(resolve(process.argv[2]),'utf8')):fixture();
  if(!Array.isArray(data.cases))throw Error('JSON deve contenere cases: []');
  const totals={casi:0,compatibili_modello:0,falsi_negativi_reali:0,falsi_negativi_sintetici:0,non_confrontabili:0};
  console.log('TURENTU POPBUS - PARITA TEMPORALE VS MODEL V2 - SOLA LETTURA');
  console.log('Modalita:',process.argv[2]?'PIANI DA JSON (verificare origine dei dati)':'FIXTURE INCORPORATE, NON ROUTING REALE');
  console.log('Modello:',modelPath);
  const start=performance.now();
  for(const [i,c] of data.cases.entries()) {
    const name=c.name||`caso_${i+1}`;
    const seeds=c.seeds||c.requests?.map(r=>Number(r.id))||[];
    const options={mode:'seeds_only',maxPeak:c.maxPeak??Infinity,...(c.options||{})};
    const real=prefiltro(c.plan,c.requests,seeds,false);
    const synthetic=prefiltro(c.plan,c.requests,seeds,true);
    let evaluation=null,error=null;
    try {evaluation=model.valutaRichieste(c.plan,c.requests,seeds,options);}catch(e){error=e.message;}
    const accepted=!!evaluation;
    const falseNegativeReal=accepted&&!real.ok;
    const falseNegativeSynthetic=accepted&&!synthetic.ok;
    const out={name,seeds,real,synthetic,modello:{accepted,peak:evaluation?.peak??null,selected:evaluation?.requests?.map(x=>x.id)||[],error},falso_negativo_tempi_reali:falseNegativeReal,falso_negativo_tempi_sintetici:falseNegativeSynthetic};
    console.log(JSON.stringify(out));
    totals.casi++;if(accepted)totals.compatibili_modello++;
    if(falseNegativeReal)totals.falsi_negativi_reali++;
    if(falseNegativeSynthetic)totals.falsi_negativi_sintetici++;
    if(error)totals.non_confrontabili++;
  }
  console.log('RIEPILOGO',JSON.stringify({...totals,ms:Number((performance.now()-start).toFixed(3))}));
  if(totals.falsi_negativi_reali>0)process.exitCode=2;
  if(totals.non_confrontabili>0)process.exitCode=3;
}
main().catch(e=>{console.error('ERRORE:',e.stack||e.message);process.exitCode=1;});
