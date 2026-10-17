// TURENTU — stress test multiscenario di selezione economica (read-only).
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
// Stress-test: stesso insieme di formazioni, scenari con prezzi, costo/km, capienza e flotta diversi.
// NON riutilizziamo una valutazione economica precalcolata: ogni candidato e' ricostruito e rivalutato.
const scenarios = [
 {name:'BASELINE',price:80,euroKm:0.5,vehiclesPerArea:2,seats:8},
 {name:'FLOTTA_RIDOTTA',price:80,euroKm:0.5,vehiclesPerArea:1,seats:8},
 {name:'CAPACITA_2',price:80,euroKm:0.5,vehiclesPerArea:2,seats:2},
 {name:'PREZZO_20',price:20,euroKm:0.5,vehiclesPerArea:2,seats:8},
 {name:'PREZZO_5',price:5,euroKm:0.5,vehiclesPerArea:2,seats:8},
 {name:'COSTO_KM_2',price:80,euroKm:2,vehiclesPerArea:2,seats:8},
 {name:'PREZZO_20_COSTO_KM_2',price:20,euroKm:2,vehiclesPerArea:2,seats:8},
];
function rebuild(rows, sc) {
 const out=[];
 for(const row of dedup(rows)) {
  const group=nodeParts(row.nodes[0]).group;
  for(const baseVehicle of byGroup.get(group)||[]) {
   if((baseVehicle.id-1000)%2>=sc.vehiclesPerArea) continue;
   if(row.evaluation.peak>sc.seats) continue;
   const v={...baseVehicle,posti_totali:sc.seats,euro_km:sc.euroKm};
   const first=row.nodes[0],last=row.nodes.at(-1);
   const approachMetres=Math.abs(nodeParts(first).pos-nodeParts(v.baseNode).pos)*12000;
   const returnMetres=Math.abs(nodeParts(last).pos-nodeParts(v.baseNode).pos)*12000;
   const approachSeconds=approachMetres/12000*720;
   const returnSeconds=returnMetres/12000*720;
   const plan=planFor(row.nodes);
   const prices=row.ids.map(()=>sc.price);
   const cost=(approachMetres+returnMetres+plan.legs.reduce((s,l)=>s+l.metres,0))/1000*sc.euroKm;
   const evaluation={...row.evaluation,revenue:Math.round(prices.reduce((a,b)=>a+b,0)*100)/100};
   const c={plan,evaluation,vehicle:v,approach:{metres:approachMetres,seconds:approachSeconds},
    returnTrip:{metres:returnMetres,seconds:returnSeconds},ricaviRichiesteEuro:prices,cost,
    busyStart:evaluation.departure-approachSeconds*1000,
    busyEnd:evaluation.arrival+returnSeconds*1000};
   const econ=economiaCandidato(c);
   if(econ?.economicamenteAttivabile) out.push(c);
  }
 }
 return out;
}
function selectAndSummarize(rows) {
 const selected=scegliAttivazioni(rows);
 const allIds=selected.flatMap(c=>c.evaluation.requests.map(r=>r.id));
 const ids=new Set(allIds);
 const econ=selected.map(economiaCandidato);
 const cents=k=>econ.reduce((sum,e)=>sum+e.centesimi[k],0)/100;
 const conflict=selected.some((a,i)=>selected.some((b,j)=>j>i&&a.vehicle.id===b.vehicle.id&&a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd));
 const ownerConcurrent=selected.some((a,i)=>selected.some((b,j)=>j>i&&a.vehicle.id!==b.vehicle.id&&a.vehicle.driver_id===b.vehicle.driver_id&&a.busyStart<b.busyEnd&&b.busyStart<a.busyEnd));
 return {candidateEconomiche:rows.length,missioni:selected.length,richiesteServite:ids.size,
  veicoliUsati:new Set(selected.map(c=>c.vehicle.id)).size,
  ricavoLordoEuro:cents('ricavoLordo'),commissioneTurentuEuro:cents('commissione'),
  costoCompletoEuro:cents('costoCompleto'),margineNettoEuro:cents('margine'),
  kmRitornoBase:selected.reduce((s,c)=>s+c.returnTrip.metres/1000,0),
  duplicati:allIds.length-ids.size,conflittiVeicolo:conflict,ownerConcurrent,
  ids:[...ids].sort((a,b)=>a-b)};
}
const results=[];
for(const sc of scenarios) {
 const p=selectAndSummarize(rebuild(pop,sc));
 const x=selectAndSummarize(rebuild(pixel,sc));
 const u=selectAndSummarize(rebuild([...pop,...pixel],sc));
 for(const [label,r] of [['POPBUS',p],['PIXEL',x],['COMBINATO',u]]) {
  check(`${sc.name} ${label}: nessun duplicato`,r.duplicati===0);
  check(`${sc.name} ${label}: nessun conflitto stesso veicolo`,!r.conflittiVeicolo);
  check(`${sc.name} ${label}: copertura non superiore a 100`,r.richiesteServite<=100);
  check(`${sc.name} ${label}: numero veicoli entro disponibilita`,r.veicoliUsati<=20*sc.vehiclesPerArea);
 }
 const strip=({ids,...rest})=>rest;
 results.push({scenario:sc, popbus:strip(p),pixel:strip(x),combinato:strip(u),
  differenzaPixelVsPopbus:{richiesteServite:x.richiesteServite-p.richiesteServite,
   margineNettoEuro:Math.round((x.margineNettoEuro-p.margineNettoEuro)*100)/100},
  combinatoPeggioreDelMigliore:u.richiesteServite<Math.max(p.richiesteServite,x.richiesteServite)});
}
const baseline=results[0];
check('Baseline riproduce 80 richieste POPBUS e 100 PIXEL',baseline.popbus.richiesteServite===80&&baseline.pixel.richiesteServite===100);
check('Flotta ridotta usa massimo 20 veicoli',results[1].popbus.veicoliUsati<=20&&results[1].pixel.veicoliUsati<=20);
check('Capienza 2 non produce missioni con picco superiore a 2',
 [...rebuild(pop,scenarios[2]),...rebuild(pixel,scenarios[2])].every(c=>c.evaluation.peak<=2));
check('Ricalcolo costi e prezzi eseguito su ogni candidato',results.every(r=>Number.isFinite(r.pixel.margineNettoEuro)&&Number.isFinite(r.popbus.margineNettoEuro)));
const report={test:'TURENTU PIXEL vs POPBUS V2 — STRESS ECONOMICO MULTISCENARIO',
 modalita:'SOLA LETTURA — 100 richieste, routing MOCK, selezione POPBUS reale',
 avvertenze:[
 'Non modifica DB, non importa worker/planner, non crea missioni.',
 'Prezzi e costi sono ipotesi sintetiche, non tariffe reali.',
 'Il generatore di formazioni usa lo stesso dataset del test precedente; varia solo la selezione.',
 'La funzione scegliAttivazioni e greedy: la soluzione combinata puo peggiorare la copertura.',
 'La capacita e controllata sul picco gia calcolato; non rigenera nuove formazioni per veicoli piu piccoli.',
 'Nessun turno reale, autista fisico, vincolo DB o ciclo multi-missione verificato.',
 'margineNettoEuro rappresenta margine del ciclo simulato, NON utile della piattaforma.'
 ],
 dataset:{richieste:requests.length,aree:NUM_GROUPS,veicoliDisponibiliMassimi:vehicles.length,
 formazioniPopbus:pop.length,formazioniPixel:pixel.length},
 risultati:results,checks,
 passed:checks.filter(c=>c.pass).length,failed:checks.filter(c=>!c.pass).length};
console.log(JSON.stringify(report,null,2));
if(report.failed)process.exitCode=1;
