// TURENTU - BENCHMARK GENERAZIONE DIRETTA GRUPPI DA PIXEL
// Rinomina .txt in .mjs ed esegui: node tests/test_popbus_candidate_dirette_pixel.mjs
// SOLO MEMORIA. Nessun database, routing o worker. Node.js >= 18.
// NOTA: il benchmark NON dimostra parita' con POPBUS V2: confronta
// gruppi coperti su traiettorie sintetiche con un oracolo indipendente.
import { performance } from 'node:perf_hooks';

const BUCKET_MIN = 10, TOLLERANZA_MIN = 30, MINUTI_SEGMENTO = 10;
const BUCKET_MS = BUCKET_MIN * 60000;
const TOL_MS = TOLLERANZA_MIN * 60000;
const BASE = Date.UTC(2027, 3, 1, 8, 0);
const SIZES = [30, 100, 200, 500];

function rng(seed) { let s=seed>>>0; return () => ((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296); }
function int(random,n) { return Math.floor(random()*n); }
function scenario(n, tipo) {
  const random=rng(12026+n+(tipo==='concentrato'?10000:0));
  const requests=[];
  for(let i=0;i<n;i++) {
    const corridor=tipo==='concentrato'?int(random,2):int(random,12);
    const start=int(random, tipo==='concentrato'?12:45);
    const len=2+int(random, tipo==='concentrato'?7:5);
    const minute=(tipo==='concentrato'?int(random,12):int(random,72))*10;
    requests.push({id:i+1, corridor, start, end:start+len,
      time:BASE+minute*60000, posti:1+int(random,3)});
  }
  return requests;
}
function segKey(c,s,b) { return `${c}:${s}:${b}`; }
function routePixels(r, depart) {
  const pixels=[];
  for(let s=r.start;s<r.end;s++) {
    const t=depart+(s-r.start)*MINUTI_SEGMENTO*60000;
    pixels.push(segKey(r.corridor,s,Math.floor(t/BUCKET_MS)));
  }
  return pixels;
}
// Proiezione di tutti gli orari possibili: bucket compatibili con tolleranza.
function buildIndex(requests) {
  const index=new Map(), byId=new Map();
  for(const r of requests) {
    byId.set(r.id,r);
    for(let s=r.start;s<r.end;s++) {
      const center=r.time+(s-r.start)*MINUTI_SEGMENTO*60000;
      const first=Math.floor((center-TOL_MS)/BUCKET_MS);
      const last=Math.floor((center+TOL_MS)/BUCKET_MS);
      for(let b=first;b<=last;b++) {
        const k=segKey(r.corridor,s,b);
        if(!index.has(k)) index.set(k,new Set());
        index.get(k).add(r.id);
      }
    }
  }
  return {index,byId};
}
function covers(route, r) {
  if(route.corridor!==r.corridor || route.start>r.start || route.end<r.end) return false;
  const timeAtStart=route.depart+(r.start-route.start)*MINUTI_SEGMENTO*60000;
  return Math.abs(timeAtStart-r.time)<=TOL_MS;
}
// Candidate generate DIRETTAMENTE dai pixel: ogni richiesta e' un'ancora
// di percorso; gli ID vicini si trovano dall'indice, non da N x N.
// Questo prototipo NON costruisce ancora deviazioni, innesti o percorsi
// multi-corridoio. Quindi puo' perdere candidate valide V2.
function fromPixels(requests, index) {
  const groups=[];
  let checks=0, lookups=0;
  for(const anchor of requests) {
    const route={corridor:anchor.corridor,start:anchor.start,end:anchor.end,depart:anchor.time};
    const seen=new Set();
    for(const pixel of routePixels(anchor,anchor.time)) {
      lookups++;
      for(const id of index.index.get(pixel)||[]) seen.add(id);
    }
    const ids=[];
    for(const id of seen) {
      checks++;
      if(covers(route,index.byId.get(id))) ids.push(id);
    }
    ids.sort((a,b)=>a-b);
    groups.push({route,ids});
  }
  return {groups,checks,lookups};
}
function oracle(requests) {
  const groups=[];
  for(const anchor of requests) {
    const route={corridor:anchor.corridor,start:anchor.start,end:anchor.end,depart:anchor.time};
    const ids=requests.filter(r=>covers(route,r)).map(r=>r.id).sort((a,b)=>a-b);
    groups.push({route,ids});
  }
  return groups;
}
function compare(a,b) {
  let mismatch=0; const examples=[];
  for(let i=0;i<a.length;i++) {
    if(a[i].ids.join(',')!==b[i].ids.join(',')) {
      mismatch++; if(examples.length<3) examples.push({anchor:i+1,pixel:a[i].ids,oracle:b[i].ids});
    }
  }
  return {mismatch,examples};
}
function timed(fn) { const t=performance.now(); const value=fn(); return {value,ms:performance.now()-t}; }
console.log('TURENTU - CANDIDATE DIRETTE DA PIXEL - TEST DIAGNOSTICO');
console.log('Pixel segmento-tempo, bucket 10 min, tolleranza +/-30 min, 10 min/segmento sintetici.');
console.log('NESSUN DB / ROUTING / WORKER. Le candidate sono gruppi per traiettorie-ancora, non candidate V2.');
let failed=false;
for(const tipo of ['distribuito','concentrato']) {
  console.log('\nSCENARIO: '+tipo.toUpperCase());
  for(const n of SIZES) {
    const requests=scenario(n,tipo);
    const tIndex=timed(()=>buildIndex(requests));
    const tPixel=timed(()=>fromPixels(requests,tIndex.value));
    const tOracle=timed(()=>oracle(requests));
    const check=compare(tPixel.value.groups,tOracle.value);
    const totalPairs=n*n;
    const groups2=tPixel.value.groups.filter(g=>g.ids.length>=2).length;
    const maxGroup=Math.max(...tPixel.value.groups.map(g=>g.ids.length));
    const row={scenario:tipo,richieste:n,celle:tIndex.value.index.size,
      traiettorie_ancora:tPixel.value.groups.length,
      gruppi_con_almeno_2:groups2,max_richieste_per_gruppo:maxGroup,
      ms_indice:+tIndex.ms.toFixed(3),ms_gruppi_pixel:+tPixel.ms.toFixed(3),
      ms_totale_pixel:+(tIndex.ms+tPixel.ms).toFixed(3),
      ms_oracolo:+tOracle.ms.toFixed(3),
      verifiche_pixel:tPixel.value.checks,verifiche_oracolo:totalPairs,
      riduzione_verifiche_pct:+(100*(1-tPixel.value.checks/totalPairs)).toFixed(2),
      differenze_vs_oracolo:check.mismatch,heap_MB:+(process.memoryUsage().heapUsed/1048576).toFixed(2)};
    console.log(JSON.stringify(row));
    if(check.mismatch) { failed=true; console.log('ESEMPI DIFFERENZE',JSON.stringify(check.examples)); }
  }
}
console.log('\nLIMITI: la copertura e\' verificata su una sola direttrice e con tempi sintetici.');
console.log('Nessun confronto di parita\' con generaCandidate(), planner, capacita\', qualita\' o economia V2.');
console.log('Il costo di creazione delle traiettorie-ancora e\' incluso; il costo di trovare');
console.log('traiettorie nuove tramite unione/estensione di richieste NON e\' incluso.');
console.log(failed?'TEST FALLITO: differenze con oracolo.':'TEST SUPERATO: parita\' con oracolo sintetico.');
if(failed) process.exitCode=1;
