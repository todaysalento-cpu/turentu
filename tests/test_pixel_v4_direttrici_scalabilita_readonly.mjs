// TURENTU POPBUS - PIXEL V4: DIRETTRICI E SCALABILITA' - SOLO DATI SINTETICI
// Salvare come tests/test_pixel_v4_direttrici_scalabilita_readonly.mjs
// Eseguire: node --expose-gc tests\test_pixel_v4_direttrici_scalabilita_readonly.mjs --count=50000 --nodes=500 --seed=42
// Nessun accesso a database, filesystem o rete. Node.js standard library soltanto.
import { performance } from 'node:perf_hooks';

const argv = Object.fromEntries(process.argv.slice(2).filter(x=>x.startsWith('--') && x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(2,i),x.slice(i+1)];}));
function positiveInt(name, fallback, max){const n=Number(argv[name]??fallback);if(!Number.isSafeInteger(n)||n<1||n>max)throw Error(`--${name} deve essere intero 1..${max}`);return n;}
const COUNT=positiveInt('count',5000,200000), NODES=positiveInt('nodes',100,10000), SEED=positiveInt('seed',42,2147483647);
const MAX_CORRIDORS=positiveInt('corridors',30,500), MAX_STEPS=positiveInt('steps',30,200), WINDOW=positiveInt('window',45,1440);
if(NODES<8)throw Error('--nodes deve essere almeno 8');
let seed=SEED>>>0;function rnd(){seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;}
const pick=n=>Math.floor(rnd()*n);
const now=()=>performance.now();
const mem=()=>+(process.memoryUsage().heapUsed/1048576).toFixed(2);
function addEdge(adj,u,v,min){adj[u].push({to:v,min});}
// Grafo diretto con dorsale bidirezionale, raccordi e ramificazioni locali.
function makeGraph(n){const adj=Array.from({length:n},()=>[]);for(let i=0;i<n-1;i++){const t=3+pick(10);addEdge(adj,i,i+1,t);addEdge(adj,i+1,i,t);}for(let i=0;i<n;i++){for(const d of [3,7,13])if(i+d<n && rnd()<0.26){const t=7+d*2+pick(10);addEdge(adj,i,i+d,t);if(rnd()<0.85)addEdge(adj,i+d,i,t+pick(4));}}return adj;}
// Dijkstra semplice con heap binario; il costo e' un tempo stradale sintetico.
class Heap{constructor(){this.a=[];}push(v){const a=this.a;let i=a.length;a.push(v);while(i){let p=(i-1)>>1;if(a[p][0]<=v[0])break;a[i]=a[p];i=p;}a[i]=v;}pop(){const a=this.a,out=a[0],v=a.pop();if(a.length){let i=0;while(true){let l=i*2+1;if(l>=a.length)break;let r=l+1,j=r<a.length&&a[r][0]<a[l][0]?r:l;if(a[j][0]>=v[0])break;a[i]=a[j];i=j;}a[i]=v;}return out;}get size(){return this.a.length;}}
function shortest(adj,src,dst){if(src===dst)return {nodes:[src],minutes:0};const n=adj.length,dist=new Float64Array(n).fill(Infinity),prev=new Int32Array(n).fill(-1),h=new Heap();dist[src]=0;h.push([0,src]);while(h.size){const [du,u]=h.pop();if(du!==dist[u])continue;if(u===dst)break;for(const e of adj[u]){const nd=du+e.min;if(nd<dist[e.to]){dist[e.to]=nd;prev[e.to]=u;h.push([nd,e.to]);}}}if(!Number.isFinite(dist[dst]))return null;const path=[];for(let u=dst;u!==-1;u=prev[u])path.push(u);path.reverse();return {nodes:path,minutes:dist[dst]};}
const graph=makeGraph(NODES);const t0=now();
// Mix di domanda concentrata e distribuita, per evitare OD tutti uguali.
const hubs=Array.from({length:Math.min(18,NODES)},(_,i)=>Math.floor(i*(NODES-1)/Math.max(1,Math.min(18,NODES)-1)));
function chooseNode(){return rnd()<0.68?hubs[pick(hubs.length)]:pick(NODES);}
const groups=new Map();let totalPassengers=0;
for(let i=0;i<COUNT;i++){let o=chooseNode(),d=chooseNode();if(o===d)d=(d+1+pick(NODES-1))%NODES;const depart=pick(24*60),pax=1+pick(3);totalPassengers+=pax;const key=`${o}>${d}`;let g=groups.get(key);if(!g){g={id:key,o,d,n:0,pax:0,times:[],path:null,minutes:0};groups.set(key,g);}g.n++;g.pax+=pax;g.times.push(depart);}
const tGroup=now();
const routeCache=new Map(), edgeToGroups=new Map(), edgeWeight=new Map();let routeCalls=0,routeMissing=0;
function route(o,d){const k=`${o}>${d}`;if(!routeCache.has(k)){routeCalls++;routeCache.set(k,shortest(graph,o,d));}return routeCache.get(k);}
for(const g of groups.values()){const r=route(g.o,g.d);if(!r){routeMissing++;continue;}g.path=r.nodes;g.minutes=r.minutes;for(let j=1;j<r.nodes.length;j++){const e=`${r.nodes[j-1]}>${r.nodes[j]}`;if(!edgeToGroups.has(e))edgeToGroups.set(e,new Set());edgeToGroups.get(e).add(g.id);edgeWeight.set(e,(edgeWeight.get(e)||0)+g.n);}}
const tRoutes=now();
// Estrazione greedy di direttrici ordinate: usa domanda pesata sugli archi,
// penalizza ritorni/cicli e conserva i gruppi servibili con O prima di D.
// E' una euristica; NON e' un oracolo di ottimalita' o completezza.
const edgeEntries=[...edgeWeight.entries()].sort((a,b)=>b[1]-a[1]);
const outgoing=new Map();for(const [k,w] of edgeEntries){const [u,v]=k.split('>').map(Number);if(!outgoing.has(u))outgoing.set(u,[]);outgoing.get(u).push({v,w});}
const corridors=[], signatures=new Set();
for(const [startEdge] of edgeEntries){if(corridors.length>=MAX_CORRIDORS)break;const [start,end]=startEdge.split('>').map(Number);const nodes=[start,end],visited=new Set(nodes);while(nodes.length<MAX_STEPS){const u=nodes[nodes.length-1],options=(outgoing.get(u)||[]).filter(x=>!visited.has(x.v));if(!options.length)break;const next=options[0].v;nodes.push(next);visited.add(next);}
// Copertura OD: origine e destinazione devono apparire in ordine.
const pos=new Map(nodes.map((n,i)=>[n,i]));const covered=[];let coveredRequests=0;
for(const g of groups.values()){const a=pos.get(g.o),b=pos.get(g.d);if(a!==undefined&&b!==undefined&&a<b){covered.push(g.id);coveredRequests+=g.n;}}
if(!covered.length)continue;const sig=nodes.join('>');if(signatures.has(sig))continue;signatures.add(sig);corridors.push({nodes,groups:covered.length,requests:coveredRequests,groupIds:covered});}
const tCorridors=now();
// Connessioni sequenziali: si cercano SOLO tra gli estremi dei gruppi,
// usando un indice per nodo d'origine. La finestra e' un filtro sul trasferimento,
// NON certifica la fattibilita' temporale delle singole richieste.
const byOrigin=new Map();for(const g of groups.values()){if(!byOrigin.has(g.o))byOrigin.set(g.o,[]);byOrigin.get(g.o).push(g);}
const uniqueDest=[...new Set([...groups.values()].map(g=>g.d))];let connectionRoutes=0,connectionGroups=0,reachablePairs=0;
const reachableByDest=new Map();
for(const d of uniqueDest){const found=[];for(const o of byOrigin.keys()){if(d===o){found.push(o);continue;}connectionRoutes++;const r=route(d,o);if(r&&r.minutes<=WINDOW)found.push(o);}reachableByDest.set(d,found);}
for(const g of groups.values()){for(const o of reachableByDest.get(g.d)||[]){for(const other of byOrigin.get(o)||[]){if(other.id!==g.id)reachablePairs++;}connectionGroups++;}}
const tConnect=now();
// Misura di copertura: un gruppo puo' apparire su piu' direttrici; deduplica.
const coveredSet=new Set(corridors.flatMap(c=>c.groupIds));let uniqueCoveredRequests=0;for(const id of coveredSet)uniqueCoveredRequests+=groups.get(id).n;
const tEnd=now();
console.log('\n=== TURENTU POPBUS PIXEL V4 - DIRETTRICI SCALABILITA (SINTETICO / READONLY) ===');
console.log(`seed=${SEED} richieste=${COUNT} nodi=${NODES} max_direttrici=${MAX_CORRIDORS} max_passi=${MAX_STEPS} collegamento_max=${WINDOW}min`);
console.log('\nCOMPRESSIONE');console.table([{richieste:COUNT,gruppi_od:groups.size,compressione_percento:+(100*(1-groups.size/COUNT)).toFixed(2),passeggeri:totalPassengers}]);
console.log('GRAFO / ROUTING');console.table([{nodi:NODES,archi_rete:graph.reduce((s,a)=>s+a.length,0),archi_domanda:edgeWeight.size,percorsi_cache:routeCache.size,routing_eseguiti:routeCalls,gruppi_senza_percorso:routeMissing}]);
console.log('DIRETTRICI GREEDY');console.table([{direttrici:corridors.length,gruppi_coperti_unici:coveredSet.size,richieste_coperte_uniche:uniqueCoveredRequests,copertura_richieste_percento:+(100*uniqueCoveredRequests/COUNT).toFixed(2),passi_massimi:MAX_STEPS}]);
console.log('TOP DIRETTRICI');console.table(corridors.slice().sort((a,b)=>b.requests-a.requests).slice(0,8).map((c,i)=>({rank:i+1,nodi:c.nodes.length,gruppi:c.groups,richieste:c.requests,percorso:c.nodes.slice(0,12).join('>')+(c.nodes.length>12?'...':'')})));
console.log('CONNESSIONI SEQUENZIALI STRUTTURALI');console.table([{routing_collegamenti_richiesti:connectionRoutes,origini_raggiungibili_somma:connectionGroups,coppie_gruppi_raggiungibili:reachablePairs,nota:'non verificate temporalmente'}]);
console.log('TEMPI (ms)');console.table([{generazione_e_gruppi:+(tGroup-t0).toFixed(2),grafo_e_routing:+(tRoutes-tGroup).toFixed(2),estrazione_direttrici:+(tCorridors-tRoutes).toFixed(2),connessioni:+(tConnect-tCorridors).toFixed(2),totale:+(tEnd-t0).toFixed(2),heap_MB:mem()}]);
console.log('\nLIMITI: rete e domanda sintetiche; OD esatti; un solo percorso minimo per OD; direttrici greedy non ottimali; nessuna finestra temporale reale, deviazione, capienza, veicolo o economia; la copertura non implica compatibilita.');
