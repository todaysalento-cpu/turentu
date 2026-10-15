/**
 * TURENTU POPBUS - DIAGNOSTICA INSIEMI PIXEL vs generaCandidate V2
 * Eseguire da project-root/tests: node test_popbus_parita_insiemi_v2.mjs
 * SOLA LETTURA: non importa worker, non apre DB, non modifica file.
 * Usa il vero model.js se presente in ../services/popbus/v2/model.js.
 * Verifica che ogni candidata V2 sia rappresentabile da un insieme costruito
 * tramite pixel condivisi E archi di continuita end->start.
 * NOTA: rappresentabilita per componenti e' NECESSARIA ma NON SUFFICIENTE
 * per dimostrare una traiettoria comune fattibile. Le candidate V2 possono
 * essere incompatibili temporalmente: vengono segnalate separatamente.
 */
import { performance } from 'node:perf_hooks';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PATH = resolve(process.cwd(), '../services/popbus/v2/model.js');
if (!existsSync(PATH)) {
  console.error('ERRORE: model.js non trovato:', PATH);
  console.error('Esegui dalla cartella tests, accanto a services/popbus/v2/model.js.');
  process.exit(2);
}
let generaCandidate;
try { ({ generaCandidate } = await import(pathToFileURL(PATH).href)); }
catch (e) { console.error('Impossibile importare model.js:', e.message); process.exit(2); }
if (typeof generaCandidate !== 'function') throw new Error('Export generaCandidate non disponibile');

const MIN = 60000, BUCKET = 10, TOL = 30;
const base = Date.parse('2027-04-01T08:00:00Z');
const minutes = t => Math.floor((Date.parse(t) - base) / MIN);
const bucket = t => Math.floor(t / BUCKET);
const key = (a,b) => `${a}>${b}`;
const signature = ids => [...ids].map(Number).sort((a,b)=>a-b).join(',');

// RNG deterministico: scenari riproducibili
function rng(seed) { let x=seed>>>0; return () => { x ^= x<<13; x ^= x>>>17; x ^= x<<5; return (x>>>0)/4294967296; }; }
function dataset(n, concentrated, seed) {
  const rand = rng(seed), out=[];
  for(let i=0;i<n;i++) {
    const lane = concentrated ? Math.floor(rand()*3) : Math.floor(rand()*Math.max(10,Math.ceil(n/6)));
    const pos = Math.floor(rand()*7);
    const len = 1 + Math.floor(rand()*3);
    const start = 1000 + lane*20 + pos;
    const end = start+len;
    const t = concentrated ? Math.floor(rand()*6)*10 : Math.floor(rand()*36)*10;
    out.push({id:i+1, start_node_id:start, end_node_id:end,
      start_datetime:new Date(base+t*MIN).toISOString(),
      classe:'STANDARD', posti:1});
  }
  return out;
}
function makeIndex(reqs) {
  // Pixel sintetici: segmenti numerici successivi, +/-30 min.
  const idx = new Map();
  for(const r of reqs) {
    const t = minutes(r.start_datetime);
    for(let s=r.start_node_id; s<r.end_node_id; s++) {
      for(let dt=-TOL;dt<=TOL;dt+=BUCKET) {
        const p = `${key(s,s+1)}@${bucket(t+(s-r.start_node_id)*10+dt)}`;
        if(!idx.has(p)) idx.set(p,[]);
        idx.get(p).push(r.id);
      }
    }
  }
  return idx;
}
class UF {
  constructor(n){this.p=Array.from({length:n+1},(_,i)=>i);this.sz=Array(n+1).fill(1)}
  find(x){while(this.p[x]!==x){this.p[x]=this.p[this.p[x]];x=this.p[x]}return x}
  union(a,b){let x=this.find(a),y=this.find(b);if(x===y)return;if(this.sz[x]<this.sz[y])[x,y]=[y,x];this.p[y]=x;this.sz[x]+=this.sz[y]}
}
function groups(reqs,idx) {
  const uf = new UF(reqs.length);
  let linksPixel=0,linksSequence=0;
  for(const ids of idx.values()) {
    if(ids.length<2)continue;
    for(let j=1;j<ids.length;j++){uf.union(ids[0],ids[j]);linksPixel++}
  }
  const starts=new Map();
  for(const r of reqs){if(!starts.has(r.start_node_id))starts.set(r.start_node_id,[]);starts.get(r.start_node_id).push(r)}
  // Non richiede pixel in comune: preserva anche le corse consecutive.
  // La compatibilita temporale qui e' una stima sintetica conservativa,
  // NON sostituisce il planner.
  for(const r of reqs)for(const s of starts.get(r.end_node_id)||[]) {
    const expected=minutes(r.start_datetime)+(r.end_node_id-r.start_node_id)*10;
    if(Math.abs(minutes(s.start_datetime)-expected)<=2*TOL){uf.union(r.id,s.id);linksSequence++}
  }
  const result=new Map();
  for(const r of reqs){const root=uf.find(r.id);if(!result.has(root))result.set(root,[]);result.get(root).push(r.id)}
  return {uf, result:[...result.values()], linksPixel, linksSequence};
}
function extract(c) {
  // model.js: {nodes, seeds, classe}. Manteniamo il controllo esplicito.
  if(!Array.isArray(c.seeds))throw new Error('Formato candidato V2 inatteso: seeds mancante');
  return c.seeds.map(Number);
}
function run(name, reqs) {
  const t0=performance.now();const idx=makeIndex(reqs);const t1=performance.now();
  const g=groups(reqs,idx);const t2=performance.now();
  let v2=[],error=null;
  try { v2=generaCandidate(reqs,100000); }
  catch(e){error=e.message}
  const t3=performance.now();
  let covered=0,missed=0,single=0,shared=0,unique=new Set(), examples=[];
  for(const c of v2){
    const seeds=extract(c), sig=signature(seeds);
    if(unique.has(sig))continue;unique.add(sig);
    if(seeds.length===1)single++;else shared++;
    const ok=seeds.every(id=>g.uf.find(id)===g.uf.find(seeds[0]));
    if(ok)covered++;else{missed++;if(examples.length<4)examples.push({seeds,nodes:c.nodes})}
  }
  const missingSingles=reqs.filter(r=>!unique.has(String(r.id))).map(r=>r.id);
  const max=Math.max(...g.result.map(x=>x.length));
  const out={scenario:name,richieste:reqs.length,celle_pixel:idx.size,insiemi:g.result.length,
    insieme_massimo:max,archi_pixel:g.linksPixel,archi_sequenziali:g.linksSequence,
    candidate_v2:v2.length,insiemi_seeds_v2_distinti:unique.size,
    singole_v2:single,condivise_v2:shared,seed_sets_rappresentabili:covered,
    seed_sets_non_rappresentabili:missed,singole_mancanti:missingSingles.length,
    ms_indice:+(t1-t0).toFixed(3),ms_insiemi:+(t2-t1).toFixed(3),ms_v2:+(t3-t2).toFixed(3),
    heap_MB:+(process.memoryUsage().heapUsed/1048576).toFixed(2),
    errore_v2:error,esempi_mancanti:examples};
  console.log(JSON.stringify(out));
  return out;
}
console.log('TURENTU - TEST PARITA STRUTTURALE INSIEMI PIXEL / CANDIDATE V2');
console.log('Vero generaCandidate da:',PATH);
console.log('SOLA LETTURA - Nessun DB, routing o worker. Tempi sintetici 10 min/segmento.');
console.log('ATTENZIONE: un insieme rappresenta candidate potenziali, non prova la fattibilita.');

// Fixture fondamentale: due richieste sequenziali senza alcun pixel condiviso.
const fixture=[
 {id:1,start_node_id:10,end_node_id:12,start_datetime:new Date(base).toISOString(),classe:'STANDARD'},
 {id:2,start_node_id:12,end_node_id:14,start_datetime:new Date(base+20*MIN).toISOString(),classe:'STANDARD'},
 {id:3,start_node_id:11,end_node_id:13,start_datetime:new Date(base+10*MIN).toISOString(),classe:'STANDARD'}
];
const fix=run('fixture_sequenziale_e_sovrapposta',fixture);
const outcomes=[];
for(const concentrated of [false,true]) {
  console.log('\nSCENARIO:',concentrated?'CONCENTRATO':'DISTRIBUITO');
  for(const n of [30,100,200,500])outcomes.push(run(`${concentrated?'concentrato':'distribuito'}_${n}`,dataset(n,concentrated, 20261014+n+(concentrated?1000:0))));
}
const all=[fix,...outcomes];
const errors=all.filter(x=>x.errore_v2||x.singole_mancanti);
const misses=all.filter(x=>x.seed_sets_non_rappresentabili);
console.log('\nRIEPILOGO');
console.log('Scenari con errore V2 o singole mancanti:',errors.length);
console.log('Scenari con seed-set V2 non rappresentati:',misses.length);
if(misses.length)console.log('ATTENZIONE: l indice pixel+continuita temporale perde alcune candidate V2; vedere esempi.');
if(errors.length)console.log('ATTENZIONE: il generatore V2 ha restituito errori o singole mancanti; verificare limite e formato.');
if(!errors.length&&!misses.length)console.log('PARITA STRUTTURALE OSSERVATA sui seed-set V2 degli scenari testati.');
console.log('NON e una prova di parita delle formazioni del planner o dell economia.');
