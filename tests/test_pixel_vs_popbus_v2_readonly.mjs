// TURENTU — benchmark comparativo read-only PIXEL P2.1 vs POPBUS V2.
// Copiare in tests/test_pixel_vs_popbus_v2_readonly.mjs.
// Routing sintetico, nessun DB/HTTP/worker, nessuna missione attivata.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';
import { generaCandidate, valutaRichieste } from '../services/popbus/v2/model.js';

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
const startPop = performance.now();
let popCandidates=[], popError=null;
try { popCandidates = generaCandidate(requests,500); }
catch(e) { popError=e.message; }
const popGenerationMs = performance.now()-startPop;
if (popError) {
  console.log(JSON.stringify({test:'PIXEL vs POPBUS V2',errore:'GENERATORE_POPBUS',dettaglio:popError,
    nota:'Il limite di 500 candidate e stato raggiunto; non sono prodotti risultati comparativi parziali.'},null,2));
  process.exitCode=2;
} else {
  const popValidated = [];
  const startPopValidation=performance.now();
  for(const c of popCandidates){
    const e=evaluate(c.nodes,c.seeds);
    if(e) popValidated.push({nodes:c.nodes,ids:keyIds(e.requests.map(r=>r.id)),count:e.requests.length});
  }
  const popValidationMs=performance.now()-startPopValidation;

  const engine=createIncrementalCorridorEngine({routeNodes,abilitaVariantiP1:true,
    maxVariantiPerRichiesta:4,maxNodiVariante:6,tolleranzaMinuti:30});
  const startPixel=performance.now();
  for(const r of requests) await engine.processRequest(r);
  const pixelGenerationMs=performance.now()-startPixel;
  const corridors=engine.listCorridors();
  const pixelValidated=[];
  let temporalGroups=0;
  const startPixelValidation=performance.now();
  for(const c of corridors){
    const groups=engine.temporalCandidatesComplete(c.id);
    temporalGroups+=groups.length;
    for(const g of groups){
      const ids=[...g.richiestaIds];
      const e=evaluate(c.nodes,ids);
      if(e) pixelValidated.push({nodes:c.nodes,ids:keyIds(e.requests.map(r=>r.id)),count:e.requests.length});
    }
  }
  const pixelValidationMs=performance.now()-startPixelValidation;
  const dedup=rows=>new Map(rows.map(r=>[r.ids,r]));
  const popSets=dedup(popValidated), pixelSets=dedup(pixelValidated);
  const coverage=rows=>new Set(rows.flatMap(r=>r.ids.split(',').map(Number)));
  const popCoverage=coverage(popValidated), pixelCoverage=coverage(pixelValidated);
  const intersection=[...popSets.keys()].filter(k=>pixelSets.has(k));
  const popOnly=[...popSets.keys()].filter(k=>!pixelSets.has(k));
  const pixelOnly=[...pixelSets.keys()].filter(k=>!popSets.has(k));
  const popMax=Math.max(0,...popValidated.map(r=>r.count));
  const pixelMax=Math.max(0,...pixelValidated.map(r=>r.count));
  const result={
    test:'TURENTU: PIXEL P2.1 vs POPBUS V2 — 100 richieste sintetiche',
    modalita:'SOLA LETTURA, routing MOCK',
    noteMetodologiche:[
      'POPBUS genera catene di seed; PIXEL produce gruppi temporali massimali su direttrici: i conteggi non sono equivalenti.',
      'Le formazioni vengono confrontate per insieme di ID richiesta, indipendentemente dalla geometria; la geometria puo differire.',
      'Ogni formazione e sottoposta alla stessa valutaRichieste(seeds_only,maxPeak=8) di POPBUS.',
      'I tempi includono overhead del routing MOCK; non rappresentano prestazioni di produzione.',
      'Non vengono verificati assegnazione veicoli, costi completi, ritorno base, soglie economiche, selezione globale o transazioni.',
      'I risultati valgono per questo scenario deterministico e non dimostrano la completezza generale dei generatori.'
    ],
    dataset:{richieste:requests.length,areeIndipendenti:NUM_GROUPS,richiestePerArea:5},
    popbus:{candidateGenerate:popCandidates.length,formazioniValide:popValidated.length,
      insiemiUniciValidi:popSets.size,richiesteCoperte:popCoverage.size,
      dimensioneMassimaFormazione:popMax,tempoGenerazioneMs:+popGenerationMs.toFixed(2),
      tempoValutazioneMs:+popValidationMs.toFixed(2)},
    pixel:{direttrici:corridors.length,gruppiTemporali:temporalGroups,
      formazioniValide:pixelValidated.length,insiemiUniciValidi:pixelSets.size,
      richiesteCoperte:pixelCoverage.size,dimensioneMassimaFormazione:pixelMax,
      tempoGenerazioneMs:+pixelGenerationMs.toFixed(2),tempoValutazioneMs:+pixelValidationMs.toFixed(2)},
    confronto:{insiemiComuni:intersection.length,soloPopbus:popOnly.length,soloPixel:pixelOnly.length,
      esempiSoloPopbus:popOnly.slice(0,8),esempiSoloPixel:pixelOnly.slice(0,8),
      richiesteCoperteSoloPopbus:[...popCoverage].filter(id=>!pixelCoverage.has(id)).sort((a,b)=>a-b),
      richiesteCoperteSoloPixel:[...pixelCoverage].filter(id=>!popCoverage.has(id)).sort((a,b)=>a-b)},
    checks:[
      {test:'100 richieste generate',pass:requests.length===100},
      {test:'POPBUS produce candidate',pass:popCandidates.length>0},
      {test:'PIXEL produce direttrici',pass:corridors.length>0},
      {test:'POPBUS produce formazioni validate',pass:popValidated.length>0},
      {test:'PIXEL produce formazioni validate',pass:pixelValidated.length>0},
    ]
  };
  result.passed=result.checks.filter(c=>c.pass).length;
  result.failed=result.checks.length-result.passed;
  console.log(JSON.stringify(result,null,2));
  if(result.failed)process.exitCode=1;
}
