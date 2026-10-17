// TURENTU — benchmark comparativo read-only PIXEL P2.1 vs POPBUS V2.
// Copiare in tests/test_pixel_vs_popbus_v2_readonly.mjs.
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

// 20 aree indipendenti, 5 richieste per area, con sovrapposizioni reali.
// 100 richieste in totale. Prezzi volutamente non usati come prova di attivabilita'.
const requests = [];
for (let group=0; group<NUM_GROUPS; group++) {
  const n = p => group*10 + p;
  const origin = BASE + group*60*60000;
  const templates = [
    [1,2,0], [2,3,12], [3,4,24], [1,3,0], [2,4,12],
  ];
  for (let j=0;j<templates.length;j++) {
    const [a,b,offset] = templates[j];
    requests.push({
      id: group*5+j+1,
      start_node_id:n(a), end_node_id:n(b),
      origine_nodo_territoriale_id:n(a), destinazione_nodo_territoriale_id:n(b),
      start_datetime:iso(origin+offset*60000),
      posti_richiesti:1, prezzo:80, classe:'STANDARD',
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
// Flotta: 2 mezzi per area, con lo stesso titolare dell'area; nessun vincolo fittizio per driver_id.
const vehicles=[];
for(let g=0;g<NUM_GROUPS;g++)for(let k=0;k<2;k++)vehicles.push({id:1000+g*2+k,driver_id:500+g,posti_totali:8,euro_km:0.5,baseNode:g*10+1,group:g});
const byGroup=new Map();for(const v of vehicles){if(!byGroup.has(v.group))byGroup.set(v.group,[]);byGroup.get(v.group).push(v);}
const candidateKey=c=>c.nodes.join('>')+'|'+keyIds(c.ids);
const dedup=rows=>[...new Map(rows.map(r=>[candidateKey(r),r])).values()];
const enrich=(rows)=>{
 const out=[];
 for(const row of dedup(rows)){
  const g=nodeParts(row.nodes[0]).group;
  const groupVehicles=byGroup.get(g)||[];
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
const summarize=(candidates)=>{
 const selected=scegliAttivazioni(candidates);
 const requestIds=selected.flatMap(c=>c.evaluation.requests.map(r=>r.id));
 const usedVehicles=new Set(selected.map(c=>c.vehicle.id));
 const cents=selected.map(c=>economiaCandidato(c).centesimi);
 const sum=k=>cents.reduce((a,x)=>a+x[k],0)/100;
 const ownerConcurrent=selected.some((a,i)=>selected.some((b,j)=>j>i&&a.vehicle.id!==b.vehicle.id&&a.vehicle.driver_id===b.vehicle.driver_id&&a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd));
 return {candidateEconomicamenteAmmissibili:candidates.length,missioniSelezionate:selected.length,
  richiesteServite:new Set(requestIds).size,postiRichiestiServiti:requestIds.reduce((s,id)=>s+byId.get(id).posti_richiesti,0),
  veicoliUsati:usedVehicles.size,ricavoLordoEuro:sum('ricavoLordo'),commissioneTurentuEuro:sum('commissione'),
  costoCompletoEuro:sum('costoCompleto'),margineNettoEuro:sum('margine'),
  kmRitornoBase:selected.reduce((s,c)=>s+c.returnTrip.metres/1000,0),
  proprietarioConVeicoliSimultanei:ownerConcurrent,
  richiesteDuplicate:requestIds.length-new Set(requestIds).size,
  missioni:selected.map(c=>({veicoloId:c.vehicle.id,titolareId:c.vehicle.driver_id,
   richieste:c.evaluation.requests.map(r=>r.id),busyStart:c.busyStart,busyEnd:c.busyEnd}))};
};
const popResult=summarize(popFeasible),pixelResult=summarize(pixelFeasible),unionResult=summarize(unionFeasible);
check('100 richieste e 40 veicoli sintetici',requests.length===100&&vehicles.length===40);
check('Nessun duplicato richieste POPBUS',popResult.richiesteDuplicate===0);
check('Nessun duplicato richieste PIXEL',pixelResult.richiesteDuplicate===0);
check('Nessun duplicato richieste combinato',unionResult.richiesteDuplicate===0);
check('Costo ritorno base presente in tutte le candidate',unionFeasible.every(c=>c.returnTrip.metres>=0)&&unionFeasible.some(c=>c.returnTrip.metres>0));
check('Economia completa verificata dalla funzione reale POPBUS',unionFeasible.length>0&&unionFeasible.every(c=>economiaCandidato(c)?.economicamenteAttivabile));
check('La soluzione combinata serve almeno il massimo dei singoli motori in questo scenario',unionResult.richiesteServite>=Math.max(popResult.richiesteServite,pixelResult.richiesteServite));
// Verifica diretta di due veicoli dello stesso titolare su missioni distinte simultanee.
const simultaneous=unionFeasible.find(a=>unionFeasible.some(b=>a.vehicle.id!==b.vehicle.id&&a.vehicle.driver_id===b.vehicle.driver_id&&
 a.evaluation.requests.every(r=>!b.evaluation.requests.some(q=>q.id===r.id))&&a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd));
if(simultaneous){
 const b=unionFeasible.find(b=>simultaneous.vehicle.id!==b.vehicle.id&&simultaneous.vehicle.driver_id===b.vehicle.driver_id&&
 simultaneous.evaluation.requests.every(r=>!b.evaluation.requests.some(q=>q.id===r.id))&&simultaneous.busyStart<b.busyEnd&&b.busyStart<simultaneous.busyEnd);
 check('Due mezzi distinti dello stesso titolare possono operare contemporaneamente',scegliAttivazioni([simultaneous,b]).length===2);
}else check('Scenario simultaneo stesso titolare disponibile',false,'Dataset privo di coppia valida; test da ampliare');
const compact=({missioni,...rest})=>({...rest,esempiMissioni:missioni.slice(0,5)});
const result={test:'TURENTU: selezione economica PIXEL vs POPBUS vs combinato',modalita:'READ ONLY - MOCK routing, 100 richieste, 40 veicoli',
 avvertenze:['Usa funzioni pure POPBUS: valutaRichieste, economiaCandidato, scegliAttivazioni.',
 'Non importa worker, pool, planner o adapter con effetti esterni.',
 'Confronta missioni singole; non pianifica cicli concatenati di 2-3 missioni.',
 'Prezzi sintetici di 80 EUR per richiesta, non prezzi di mercato.',
 'Distanze/tempi MOCK, senza verifica turni, disponibilita reale o vincoli transazionali.',
 'La selezione greedy POPBUS non garantisce ottimo globale e non e monotona rispetto all aggiunta di candidate.'],
 dati:{richieste:requests.length,veicoli:vehicles.length,titolari:NUM_GROUPS,candidatePopbus:pop.length,candidatePixel:pixel.length},
 popbus:compact(popResult),pixel:compact(pixelResult),combinato:compact(unionResult),checks,
 passed:checks.filter(c=>c.pass).length,failed:checks.filter(c=>!c.pass).length};
console.log(JSON.stringify(result,null,2));if(result.failed)process.exitCode=1;
