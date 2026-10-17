// TURENTU TEST 8 — eterogeneita, conflitti e selezione su candidate generate da PIXEL e POPBUS.
// Copiare in tests/test_pixel_popbus_globale_candidate_generate_readonly.mjs.
// Routing sintetico, nessun DB/HTTP/worker, nessuna missione attivata.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { generaCandidate, valutaRichieste, scegliAttivazioni, economiaCandidato } from '../services/popbus/v2/model.js';

const NUM_GROUPS = 20;
const BASE = Date.parse('2030-04-01T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const keyIds = ids => [...new Set(ids.map(Number))].sort((a,b)=>a-b).join(',');
const nodeParts = id => ({ group: Math.floor((Number(id) - 1) / 10), pos: (Number(id) - 1) % 10 });
const roadLeg = (a, b) => {
  const x = nodeParts(a), y = nodeParts(b);
  if (x.group !== y.group || x.pos === y.pos) throw Error(`ROUTING_MOCK_NON_VALIDO:${a}->${b}`);
  const steps = Math.abs(y.pos - x.pos);
  return { metres: steps * 12000, seconds: steps * 720, polyline: `mock-${a}-${b}` };
};
const routeNodes = async nodes => ({ verificataRouting: true,
  legs: nodes.slice(1).map((b,i) => roadLeg(nodes[i],b)) });

// 20 aree indipendenti, 5 richieste per area, prezzi, posti e orari eterogenei.
// 100 richieste in totale. Prezzi volutamente non usati come prova di attivabilita'.
const requests = [];
for (let group=0; group<NUM_GROUPS; group++) {
  const n = p => group*10 + p;
  const origin = BASE + group*75*60000;
  const templates = [
    [1,2,0], [2,3,12], [3,4,24], [1,3,group%3===0?6:0], [2,4,group%4===0?18:12],
  ];
  for (let j=0;j<templates.length;j++) {
    const [a,b,offset] = templates[j];
    requests.push({
      id: group*5+j+1,
      start_node_id:n(a), end_node_id:n(b),
      origine_nodo_territoriale_id:n(a), destinazione_nodo_territoriale_id:n(b),
      start_datetime:iso(origin+offset*60000),
      posti_richiesti:1+(group+j)%3, prezzo: [28,45,65,85,115][(group*3+j)%5], classe:'STANDARD',
      classe_percorrenza:'BASSA', max_fermate_intermedie:10,
      min_km_tra_fermate:0, max_deviazione_pct:100,
    });
  }
}
assert.equal(requests.length,100);
const byId = new Map(requests.map(r=>[r.id,r]));
const planFor = nodes => ({ nodes, legs:nodes.slice(1).map((b,i)=>roadLeg(nodes[i],b)) });
const evaluate = (nodes, ids) => {
  const unique = [...new Set(ids.map(Number))];
  if (!unique.length || unique.length!==ids.length) return null;
  try {
    const e = valutaRichieste(planFor(nodes),unique.map(id=>byId.get(id)).filter(Boolean),unique,
      {mode:'seeds_only',maxPeak:8});
    return e?.requests.length===unique.length ? e : null;
  } catch (error) {
    return null;
  }
};

// Confronto di selezione: stessa flotta, stessi costi, stesso algoritmo POPBUS.
// Le missioni candidate sono indipendenti: NON implementa cicli multi-missione.
const checks=[];
const check=(name,pass,detail=null)=>checks.push({test:name,pass:Boolean(pass),...(detail?{detail}: {})});
const popRaw=generaCandidate(requests,500);
const pop=[];
for(const c of popRaw){const e=evaluate(c.nodes,c.seeds);if(e)pop.push({nodes:c.nodes,ids:e.requests.map(r=>r.id),evaluation:e});}
const engine=createIncrementalCorridorEngine({routeNodes,abilitaVariantiP1:true,maxVariantiPerRichiesta:4,maxNodiVariante:6,tolleranzaMinuti:30});
for(const r of requests) await engine.processRequest(r);
const pixel=[];
for(const c of engine.listCorridors())for(const g of engine.temporalCandidatesComplete(c.id)){
 const e=evaluate(c.nodes,[...g.richiestaIds]);
 if(e)pixel.push({nodes:c.nodes,ids:e.requests.map(r=>r.id),evaluation:e});
}
// Flotta eterogenea: 2 mezzi per area, stesso titolare; basi, tariffe e capacita diverse.
const vehicles=[];
for(let g=0;g<NUM_GROUPS;g++)for(let k=0;k<2;k++)vehicles.push({id:1000+g*2+k,driver_id:500+g,posti_totali: k===0?4+(g%3):6+(g%3),euro_km: [0.45,0.65,0.95,1.2][(g+k)%4],baseNode:g*10+(k===0?1:3),group:g});
const byGroup=new Map();for(const v of vehicles){if(!byGroup.has(v.group))byGroup.set(v.group,[]);byGroup.get(v.group).push(v);}
const candidateKey=c=>c.nodes.join('>')+'|'+keyIds(c.ids);
const dedup=rows=>[...new Map(rows.map(r=>[candidateKey(r),r])).values()];
const enrich=(rows)=>{
 const out=[];
 for(const row of dedup(rows)){
  const g=nodeParts(row.nodes[0]).group;
  const groupVehicles=(byGroup.get(g)||[]).filter(v=>row.ids.reduce((n,id)=>n+(byId.get(id)?.posti_richiesti||0),0)<=v.posti_totali);
  if(row.nodes.some(n=>nodeParts(n).group!==g))throw Error('CROSS_AREA_UNEXPECTED');
  for(const v of groupVehicles){
   const first=row.nodes[0],last=row.nodes.at(-1);
   const approachMetres=Math.abs(nodeParts(first).pos-nodeParts(v.baseNode).pos)*12000;
   const returnMetres=Math.abs(nodeParts(last).pos-nodeParts(v.baseNode).pos)*12000;
   const approachSeconds=approachMetres/12000*720;
   const returnSeconds=returnMetres/12000*720;
   const plan=planFor(row.nodes);
   const ricaviRichiesteEuro=row.ids.map(id=>byId.get(id).prezzo);
   const cost=(approachMetres+returnMetres+plan.legs.reduce((s,l)=>s+l.metres,0))/1000*v.euro_km;
   const c={plan,evaluation:row.evaluation,vehicle:v,
    approach:{metres:approachMetres,seconds:approachSeconds},
    returnTrip:{metres:returnMetres,seconds:returnSeconds},
    ricaviRichiesteEuro,cost,
    busyStart:row.evaluation.departure-approachSeconds*1000,
    busyEnd:row.evaluation.arrival+returnSeconds*1000};
   const economy=economiaCandidato(c);
   if(economy?.economicamenteAttivabile)out.push(c);
  }
 }
 return out;
};
const popFeasible=enrich(pop),pixelFeasible=enrich(pixel),unionFeasible=enrich([...pop,...pixel]);

// Le candidate provengono da generaCandidate() e createIncrementalCorridorEngine(),
// validate da valutaRichieste() ed economiaCandidato(). NON sono cicli sintetici prefabbricati.
// Ogni candidata rappresenta UNA missione. La concatenazione multi-missione resta fuori scope.
const cents = c => economiaCandidato(c)?.centesimi?.margine;
const reqIds = c => c.evaluation.requests.map(r => String(r.id));
const overlap = (a,b) => a.busyStart < b.busyEnd && b.busyStart < a.busyEnd;
const conflict = (a,b) => reqIds(a).some(id => reqIds(b).includes(id)) ||
  (String(a.vehicle.id)===String(b.vehicle.id) && overlap(a,b));
const candidateId = c => `${c.vehicle.id}|${c.plan.nodes.join('>')}|${reqIds(c).sort().join(',')}`;
function uniqueCandidates(rows) {
 const seen=new Set(), out=[];
 for(const c of rows){const id=candidateId(c);if(!seen.has(id)){seen.add(id);out.push(c);}}
 return out;
}
const valid = c => Number.isSafeInteger(cents(c)) && cents(c)>0 &&
 Number.isFinite(c.busyStart) && Number.isFinite(c.busyEnd) && c.busyStart<c.busyEnd &&
 reqIds(c).length>0 && new Set(reqIds(c)).size===reqIds(c).length;
const score = rows => ({margineCentesimi:rows.reduce((s,c)=>s+cents(c),0),
 richiesteServite:new Set(rows.flatMap(reqIds)).size,missioni:rows.length});
const better = (a,b) => a.margineCentesimi-b.margineCentesimi || a.richiesteServite-b.richiesteServite || a.missioni-b.missioni;
const solutionOK = rows => rows.every(valid) && rows.every((c,i)=>rows.slice(i+1).every(d=>!conflict(c,d)));
function components(rows) {
 const a=uniqueCandidates(rows).filter(valid), n=a.length;
 const adj=Array.from({length:n},()=>[]);
 for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) if(conflict(a[i],a[j])) {adj[i].push(j);adj[j].push(i);}
 const seen=new Set(), out=[];
 for(let i=0;i<n;i++) if(!seen.has(i)){
  const todo=[i], group=[];seen.add(i);
  while(todo.length){const u=todo.pop();group.push(a[u]);for(const v of adj[u])if(!seen.has(v)){seen.add(v);todo.push(v);}}
  out.push(group);
 }
 return out;
}
function greedyMargin(rows) {
 const selected=[];
 for(const c of [...rows].filter(valid).sort((a,b)=>cents(b)-cents(a)||candidateId(a).localeCompare(candidateId(b))))
  if(selected.every(d=>!conflict(c,d)))selected.push(c);
 return selected;
}
function exactGroup(group) {
 const a=[...group].sort((x,y)=>cents(y)-cents(x)||candidateId(x).localeCompare(candidateId(y)));
 const suffix=Array(a.length+1).fill(0);
 for(let i=a.length-1;i>=0;i--)suffix[i]=suffix[i+1]+cents(a[i]);
 let best=[],bestScore=score([]),visited=0;
 function visit(i,chosen,total){
  visited++;
  if(total+suffix[i]<bestScore.margineCentesimi)return;
  if(i===a.length){const s=score(chosen);if(better(s,bestScore)>0){best=[...chosen];bestScore=s;}return;}
  if(chosen.every(c=>!conflict(c,a[i]))){chosen.push(a[i]);visit(i+1,chosen,total+cents(a[i]));chosen.pop();}
  visit(i+1,chosen,total);
 }
 visit(0,[],0);return {chosen:best,visited};
}
function globalSelect(rows,limit=20) {
 const groups=components(rows), selected=[];
 let exact=0,fallback=0,largest=0,visited=0;
 for(const group of groups){
  largest=Math.max(largest,group.length);
  if(group.length<=limit){const x=exactGroup(group);selected.push(...x.chosen);visited+=x.visited;exact++;}
  else{selected.push(...greedyMargin(group));fallback++;}
 }
 return {selected,certificatoOttimo:fallback===0,componenti:groups.length,componentiEsatte:exact,
  componentiFallback:fallback,componenteMassima:largest,nodiVisitati:visited};
}
// Miglioramento locale: prova a sostituire UNA missione scelta con fino a DUE escluse.
// Non e un solver esatto, e serve a rilevare rimpianto greedy anche nelle componenti in fallback.
function localSwap(rows, rounds=4, budget=150000){
 let chosen=greedyMargin(rows), moves=0, examined=0;
 const all=uniqueCandidates(rows).filter(valid);
 for(let round=0;round<rounds;round++){
  let best=null;
  for(let i=0;i<chosen.length && examined<budget;i++){
   const rest=chosen.filter((_,j)=>i!==j);
   const excluded=all.filter(c=>!chosen.includes(c)&&rest.every(d=>!conflict(c,d)));
   for(let j=0;j<excluded.length && examined<budget;j++){
    const a=excluded[j];examined++;
    const trial1=[...rest,a];
    if(better(score(trial1),score(chosen))>0 && (!best||better(score(trial1),score(best))>0))best=trial1;
    for(let k=j+1;k<excluded.length && examined<budget;k++){
     examined++;const b=excluded[k];if(conflict(a,b))continue;
     const trial=[...rest,a,b];
     if(better(score(trial),score(chosen))>0 && (!best||better(score(trial),score(best))>0))best=trial;
    }
   }
  }
  if(!best)break;chosen=best;moves++;
 }
 return {selected:chosen,moves,examined,budgetReached:examined>=budget};
}
function describe(rows){
 const s=score(rows);
 return {missioni:s.missioni,richiesteServite:s.richiesteServite,margineEuro:s.margineCentesimi/100,
  commissioneTurentuEuro:rows.reduce((a,c)=>a+economiaCandidato(c).centesimi.commissione,0)/100,
  veicoliUsati:new Set(rows.map(c=>c.vehicle.id)).size,senzaConflitti:solutionOK(rows),
  esempi:rows.slice(0,4).map(c=>({veicolo:c.vehicle.id,richieste:reqIds(c),margineEuro:cents(c)/100}))};
}
function compareEngines(label,rows){
 const data=uniqueCandidates(rows).filter(valid);
 const t0=performance.now(),real=scegliAttivazioni(data),t1=performance.now();
 const mg=greedyMargin(data),t2=performance.now();
 const gl=globalSelect(data),t3=performance.now();
 const ls=localSwap(data),t4=performance.now();
 const a=describe(real),b=describe(mg),c=describe(gl.selected),d=describe(ls.selected);
 check(`${label}: POPBUS reale senza conflitti`,a.senzaConflitti);
 check(`${label}: greedy margine senza conflitti`,b.senzaConflitti);
 check(`${label}: globale senza conflitti`,c.senzaConflitti);
 check(`${label}: globale non peggiore della greedy margine`,c.margineEuro+0.00001>=b.margineEuro);
 check(`${label}: globale non peggiore del POPBUS reale`,c.margineEuro+0.00001>=a.margineEuro);
 check(`${label}: scambi locali senza conflitti`,d.senzaConflitti);
 check(`${label}: scambi locali non peggiorano greedy`,d.margineEuro>=b.margineEuro);
 check(`${label}: ottimo certificato solo senza fallback`,gl.certificatoOttimo===(gl.componentiFallback===0));
 return {candidateGenerate:data.length,popbusReale:a,greedyMargine:b,globale:c,scambiLocali:{...d,miglioramenti:ls.moves,candidateEsaminate:ls.examined,budgetEsaurito:ls.budgetReached},
  miglioramentoVsPopbusEuro:Number((c.margineEuro-a.margineEuro).toFixed(2)),
  miglioramentoVsGreedyMargineEuro:Number((c.margineEuro-b.margineEuro).toFixed(2)),
  ottimizzazione:{certificatoOttimo:gl.certificatoOttimo,componenti:gl.componenti,
   componentiEsatte:gl.componentiEsatte,componentiFallback:gl.componentiFallback,
   componenteMassima:gl.componenteMassima,nodiVisitati:gl.nodiVisitati},
  tempiMs:{popbus:Number((t1-t0).toFixed(3)),greedyMargine:Number((t2-t1).toFixed(3)),globale:Number((t3-t2).toFixed(3)),scambiLocali:Number((t4-t3).toFixed(3))}};
}
const scenarios={
 soloPopbus:compareEngines('Solo POPBUS',popFeasible),
 soloPixel:compareEngines('Solo PIXEL',pixelFeasible),
 combinato:compareEngines('Combinato',unionFeasible)
};
check('100 richieste, 40 veicoli',requests.length===100&&vehicles.length===40);
check('Prezzi eterogenei',new Set(requests.map(r=>r.prezzo)).size>=4);
check('Posti richiesti eterogenei',new Set(requests.map(r=>r.posti_richiesti)).size>=3);
check('Tariffe veicoli eterogenee',new Set(vehicles.map(v=>v.euro_km)).size>=4);
check('Capacita veicoli eterogenee',new Set(vehicles.map(v=>v.posti_totali)).size>=3);
check('Candidate POPBUS generate',pop.length>0);
check('Candidate PIXEL generate',pixel.length>0);
check('Tutte le candidate sottoposte a economia POPBUS',unionFeasible.every(c=>economiaCandidato(c)?.economicamenteAttivabile));
const report={test:'TURENTU TEST 8 — GLOBALE SU CANDIDATE GENERATE PIXEL/POPBUS',
 modalita:'SOLA LETTURA — generatori REALI, richieste e routing MOCK, nessun DB/worker',
 avvertenze:[
  'Candidate generate da POPBUS V2 e PIXEL P2.1; domande sintetiche con orari, prezzi, posti e tariffe eterogenei.',
  'Gli scambi locali sono un euristico sperimentale: NON certificano ottimo globale.',
  'Usa valutaRichieste, economiaCandidato e scegliAttivazioni reali di POPBUS.',
  'Ottimizzatore globale sperimentale nel solo test; non e integrato nel worker.',
  'Confronta missioni singole, NON cicli concatenati da 2-3 missioni.',
  'Componenti oltre 20 candidate: fallback greedy; NON si certifica ottimo.',
  'Il benchmark non rappresenta il traffico stradale reale e mantiene 20 aree indipendenti.',
  'Costo routing e tariffe simulati, nessun DB, turni reali o transazioni.',
  'MargineEuro e margine del ciclo, non utile Turentu; commissione separata.'
 ],
 dataset:{richieste:requests.length,veicoli:vehicles.length,prezzi:[...new Set(requests.map(r=>r.prezzo))].sort((a,b)=>a-b),tariffe:[...new Set(vehicles.map(v=>v.euro_km))].sort((a,b)=>a-b),formazioniPopbus:pop.length,
  formazioniPixel:pixel.length,candidateEconomichePopbus:popFeasible.length,
  candidateEconomichePixel:pixelFeasible.length,candidateEconomicheCombinato:unionFeasible.length},
 scenari:scenarios,checks,passed:checks.filter(c=>c.pass).length,failed:checks.filter(c=>!c.pass).length};
console.log(JSON.stringify(report,null,2));
if(report.failed)process.exitCode=1;
