/**
 * TURENTU POPBUS - PIXEL V4 - TEST GRUPPI O/D E GRAFO DELLA DOMANDA
 * Sola lettura, sintetico, nessuna dipendenza esterna, nessun accesso al DB.
 * CMD: node tests\test_pixel_v4_gruppi_od_readonly.mjs
 * Opzioni: --count=50000 --seed=42 --spread=0.15 --window=45
 * spread = probabilita' di creare richieste O/D poco ricorrenti.
 */
const args = Object.fromEntries(process.argv.slice(2).filter(x=>x.startsWith('--')).map(x=>{const [k,v]=x.slice(2).split('=');return [k,v];}));
const N=Math.max(1,Math.min(100000,Number(args.count??5000)));
const SEED=Number(args.seed??42);
const SPREAD=Math.max(0,Math.min(1,Number(args.spread??0.15)));
const WINDOW=Math.max(0,Number(args.window??45));
let s=SEED>>>0;
function rnd(){s=(Math.imul(1664525,s)+1013904223)>>>0;return s/4294967296;}
function ri(n){return Math.floor(rnd()*n);}
function key(a,b){return `${a}>${b}`;}
// Rete diretta: dorsale A0..A11 con rami a B0..B5 e C0..C5.
// Ogni arco ha durata e distanza sintetiche; non rappresenta strade reali.
const adj=new Map();const nodes=[];
function node(n){if(!adj.has(n)){adj.set(n,[]);nodes.push(n);}}
function edge(a,b,km=5,min=6){node(a);node(b);adj.get(a).push({to:b,km,min});}
for(let i=0;i<12;i++)node(`A${i}`);
for(let i=0;i<11;i++){edge(`A${i}`,`A${i+1}`);edge(`A${i+1}`,`A${i}`);}
for(let i=0;i<6;i++){node(`B${i}`);node(`C${i}`);}
for(let i=0;i<5;i++){edge(`B${i}`,`B${i+1}`,3,4);edge(`B${i+1}`,`B${i}`,3,4);edge(`C${i}`,`C${i+1}`,4,5);edge(`C${i+1}`,`C${i}`,4,5);}
for(const [a,b] of [['A2','B0'],['A6','B3'],['A4','C0'],['A9','C4']]){edge(a,b,4,5);edge(b,a,4,5);}
const graphEdges=[...adj.values()].reduce((n,a)=>n+a.length,0);
function route(start,end){
 if(start===end)return {nodes:[start],edges:[],km:0,min:0};
 const dist=new Map([[start,0]]),prev=new Map(),todo=new Set(nodes);
 while(todo.size){let u=null,best=Infinity;for(const v of todo){const d=dist.get(v)??Infinity;if(d<best){best=d;u=v;}}if(u===null)break;todo.delete(u);if(u===end)break;for(const e of adj.get(u)){const d=best+e.min;if(d<(dist.get(e.to)??Infinity)){dist.set(e.to,d);prev.set(e.to,{from:u,e});}}}
 if(!prev.has(end))return null;
 const path=[end],edges=[];let at=end,km=0,min=0;
 while(at!==start){const p=prev.get(at);if(!p)return null;edges.push({from:p.from,to:at,...p.e});km+=p.e.km;min+=p.e.min;at=p.from;path.push(at);}
 return {nodes:path.reverse(),edges:edges.reverse(),km,min};
}
// OD ricorrenti, anche sovrapposti e concatenabili.
const popular=[['A0','A6'],['A2','A9'],['A4','A11'],['A0','B4'],['B0','A9'],['A4','C5'],['C0','A11'],['A6','A11'],['A0','A3'],['A4','A7'],['A8','A11'],['B3','C5']];
const requests=[];
for(let i=0;i<N;i++){
 let a,b;
 if(rnd()<SPREAD){a=nodes[ri(nodes.length)];b=nodes[ri(nodes.length)];if(a===b)b=nodes[(nodes.indexOf(a)+1)%nodes.length];}
 else [a,b]=popular[ri(popular.length)];
 const peak=ri(4);const minute=8*60+peak*150+ri(80);
 requests.push({id:i+1,o:a,d:b,t:minute,pax:1+ri(3)});
}
const t0=performance.now();
const groups=new Map();for(const r of requests){const k=key(r.o,r.d);let g=groups.get(k);if(!g){g={id:k,o:r.o,d:r.d,requests:[]};groups.set(k,g);}g.requests.push(r);}
const tGroup=performance.now();
const cache=new Map();let routeCalls=0;
function getRoute(a,b){const k=key(a,b);if(!cache.has(k)){routeCalls++;cache.set(k,route(a,b));}return cache.get(k);}
const pixelIndex=new Map(),startIndex=new Map(),endIndex=new Map(),unroutable=[];
function addIndex(idx,k,id){let set=idx.get(k);if(!set){set=new Set();idx.set(k,set);}set.add(id);}
for(const g of groups.values()){
 g.route=getRoute(g.o,g.d);
 if(!g.route){unroutable.push(g.id);continue;}
 addIndex(startIndex,g.o,g.id);addIndex(endIndex,g.d,g.id);
 for(const e of g.route.edges)addIndex(pixelIndex,key(e.from,e.to),g.id);
}
const tGraph=performance.now();
// Group graph: overlap via inverted index, not quadratic all-pairs.
const overlapPairs=new Set();
for(const ids of pixelIndex.values()){const a=[...ids];for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++){const x=a[i]<a[j]?a[i]:a[j],y=a[i]<a[j]?a[j]:a[i];overlapPairs.add(`${x}|${y}`);}}
const tOverlap=performance.now();
// Sequential connections: from end of a group to start of another, at most
// WINDOW minutes by road. Different from overlap and preserves disjoint routes.
const seqPairs=new Set();let connectorTests=0;
for(const [dest,ending] of endIndex){
 for(const [origin,starting] of startIndex){
  connectorTests++;
  const link=getRoute(dest,origin);
  if(!link||link.min>WINDOW)continue;
  for(const a of ending)for(const b of starting){if(a!==b)seqPairs.add(`${a}|${b}`);}
 }
}
const tSeq=performance.now();
// Lightweight temporal test on sampled requests from group edges:
// test if R2 pickup can occur after R1 delivery + connector within tolerance.
let temporalChecked=0,temporalPossible=0;
const MAX_CHECK=20000;
for(const pair of seqPairs){if(temporalChecked>=MAX_CHECK)break;const cut=pair.indexOf('|'),a=groups.get(pair.slice(0,cut)),b=groups.get(pair.slice(cut+1));if(!a?.route||!b?.route)continue;const link=getRoute(a.d,b.o);if(!link)continue;
 for(const r1 of a.requests.slice(0,2))for(const r2 of b.requests.slice(0,2)){
  if(temporalChecked>=MAX_CHECK)break;
  temporalChecked++;
  // Assumption: r1 pickup fixed at requested minute, r2 +/- 15 minutes.
  const arrival=r1.t+a.route.min+link.min;
  if(arrival<=r2.t+15)temporalPossible++;
 }
}
const tEnd=performance.now();
const activeEdges=new Set(pixelIndex.keys());
const multiEdges=[...pixelIndex.values()].filter(s=>s.size>1).length;
const groupSizes=[...groups.values()].map(g=>g.requests.length).sort((a,b)=>b-a);
const top=[...groups.values()].sort((a,b)=>b.requests.length-a.requests.length).slice(0,8).map(g=>({OD:g.id,richieste:g.requests.length,archi:g.route?.edges.length??0}));
console.log('\n=== TURENTU POPBUS - PIXEL V4 - TEST SINTETICO READONLY ===');
console.log(`seed=${SEED} richieste=${N} spread=${SPREAD} collegamento_max=${WINDOW}min`);
console.log('\nRETE SINTETICA');console.table([{nodi:nodes.length,archi_diretti:graphEdges}]);
console.log('\nCOMPRESSIONE O/D');console.table([{richieste:N,gruppi_od:groups.size,compressione_percento:+((1-groups.size/N)*100).toFixed(2),gruppo_massimo:groupSizes[0],mediana_gruppo:groupSizes[Math.floor(groupSizes.length/2)]}]);
console.log('GRUPPI PRINCIPALI');console.table(top);
console.log('\nGRAFO DELLA DOMANDA');console.table([{archi_attivi:activeEdges.size,archi_con_piu_gruppi:multiEdges,coppie_gruppi_overlap:overlapPairs.size,coppie_gruppi_sequenziali_orientate:seqPairs.size,gruppi_non_raggiungibili:unroutable.length}]);
console.log('\nOPERAZIONI');console.table([{routing_teorico_individuale:N,routing_OD_iniziale:groups.size,routing_effettivo_con_cache:routeCalls,test_collegamenti_nodi:connectorTests,coppie_tutti_i_gruppi:groups.size*(groups.size-1)/2,verifiche_temporali_campionate:temporalChecked,sequenze_temporalmente_possibili:temporalPossible}]);
console.log('\nTEMPI (ms)');console.table([{raggruppamento:+(tGroup-t0).toFixed(2),grafo_e_routing:+(tGraph-tGroup).toFixed(2),overlap:+(tOverlap-tGraph).toFixed(2),sequenze:+(tSeq-tOverlap).toFixed(2),temporale:+(tEnd-tSeq).toFixed(2),totale:+(tEnd-t0).toFixed(2)}]);
console.log('\nLIMITI: routing sintetico su grafo piccolo; cluster O/D esatti; tempi statici; nessun veicolo, capienza, deviazione individuale o economia; non prova completezza delle candidate V2.');
console.log('NOTA: le coppie sequenziali sono strutturali; il controllo temporale e solo campionario, non certifica una missione.');
