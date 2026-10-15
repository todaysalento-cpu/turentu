/**
 * TURENTU POPBUS - SPAZIO -> TRAIETTORIE -> TEMPO -> INSIEMI
 * Test diagnostico autonomo, sola memoria. Nessun DB, routing, worker o scrittura.
 * node test_popbus_spazio_tempo_insiemi.mjs
 * Optional: importa services/popbus/v2/model.js e confronta i seed-set di generaCandidate.
 * ATTENZIONE: offset sintetico 10 minuti per arco, traiettorie lineari per corridoio.
 */
import { performance } from 'node:perf_hooks';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIN = 60_000;
const TOL = 30;
const MIN_PER_EDGE = 10;
const CASES = [30, 100, 200, 500];
const ts = (m) => new Date(Date.UTC(2027, 3, 1, 0, m)).toISOString();
const rnd = (seed) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2**32);
const nId = (corridor, pos) => corridor * 1000 + pos + 1;
const nPos = (id) => (id - 1) % 1000;
const corridorOf = (id) => Math.floor((id - 1) / 1000);
const timeMinutes = (iso) => Date.parse(iso) / MIN;
const round = (v) => Math.round(v * 1000) / 1000;

function makeRequests(count, mode) {
  const r = rnd(20261014 + count * 11 + (mode === 'concentrato' ? 7 : 0));
  const corridors = mode === 'concentrato' ? 3 : Math.max(10, Math.ceil(count / 14));
  const result = [];
  for (let i = 0; i < count; i++) {
    const corridor = mode === 'concentrato' ? i % corridors : Math.floor(r() * corridors);
    const start = Math.floor(r() * (mode === 'concentrato' ? 14 : 22));
    const len = 1 + Math.floor(r() * (mode === 'concentrato' ? 6 : 4));
    const time = mode === 'concentrato' ? 9 * 60 + Math.floor(r() * 100) : 7 * 60 + Math.floor(r() * 12 * 60);
    result.push({id:i+1,start_node_id:nId(corridor,start),end_node_id:nId(corridor,start+len),start_datetime:ts(time),classe:'STANDARD'});
  }
  return result;
}

function fixtures() {
  // R1 A->C, R2 B->D (overlap), R3 D->E (sequential), R4 B->C at 11:00 (temporally distant)
  return [
    {id:1,start_node_id:nId(0,0),end_node_id:nId(0,2),start_datetime:ts(9*60)},
    {id:2,start_node_id:nId(0,1),end_node_id:nId(0,3),start_datetime:ts(9*60+12)},
    {id:3,start_node_id:nId(0,3),end_node_id:nId(0,4),start_datetime:ts(9*60+34)},
    {id:4,start_node_id:nId(0,1),end_node_id:nId(0,2),start_datetime:ts(11*60)},
    {id:5,start_node_id:nId(0,0),end_node_id:nId(0,4),start_datetime:ts(9*60+1)}
  ];
}

function spatialTrajectories(reqs) {
  const byCorridor = new Map();
  const trajectories = new Map();
  const add = (corridor, start, end) => {
    if (start >= end) return;
    const key = `${corridor}:${start}:${end}`;
    if (!trajectories.has(key)) trajectories.set(key,{corridor,start,end,key});
  };
  for (const r of reqs) {
    const c = corridorOf(r.start_node_id);
    const start = nPos(r.start_node_id), end = nPos(r.end_node_id);
    if (c !== corridorOf(r.end_node_id) || end <= start) throw Error(`Richiesta ${r.id} non lineare`);
    add(c,start,end); // every request is an anchor, independent of grouping
    if (!byCorridor.has(c)) byCorridor.set(c,[]);
    byCorridor.get(c).push({start,end});
  }
  let merged = 0;
  for (const [c, intervals] of byCorridor) {
    intervals.sort((a,b)=>a.start-b.start || a.end-b.end);
    let a=null,b=null;
    for (const p of intervals) {
      if (a===null) {a=p.start;b=p.end;continue;}
      if (p.start<=b) b=Math.max(b,p.end); // includes end->start chains
      else {add(c,a,b);merged++;a=p.start;b=p.end;}
    }
    if (a!==null) {add(c,a,b);merged++;}
  }
  return {trajectories:[...trajectories.values()],merged};
}

function buildGroups(reqs, trajectories) {
  const byCorridor = new Map();
  for (const r of reqs) {
    const c=corridorOf(r.start_node_id);
    if (!byCorridor.has(c)) byCorridor.set(c,[]);
    byCorridor.get(c).push(r);
  }
  const groups = new Map();
  let spatialChecks=0, covered=0, temporalWindows=0;
  for (const tr of trajectories) {
    const events=[];
    for (const r of byCorridor.get(tr.corridor)||[]) {
      spatialChecks++;
      const start=nPos(r.start_node_id),end=nPos(r.end_node_id);
      if (start<tr.start || end>tr.end) continue;
      covered++;
      // Shift the request's allowed pickup time to trajectory origin.
      // These are REAL intervals under the SYNTHETIC fixed edge-duration model.
      const offset=(start-tr.start)*MIN_PER_EDGE;
      const nominal=timeMinutes(r.start_datetime)-offset;
      events.push({t:nominal-TOL,id:r.id,delta:+1});
      events.push({t:nominal+TOL+1e-5,id:r.id,delta:-1});
    }
    events.sort((a,b)=>a.t-b.t || b.delta-a.delta);
    const active=new Set();
    for(let i=0;i<events.length;) {
      const t=events[i].t;
      while(i<events.length && events[i].t===t) {
        if(events[i].delta>0) active.add(events[i].id);
        else active.delete(events[i].id);
        i++;
      }
      const next=i<events.length?events[i].t:null;
      if(next!==null && next>t && active.size>=2) {
        temporalWindows++;
        const ids=[...active].sort((a,b)=>a-b);
        const key=tr.key+'|'+ids.join(',');
        const old=groups.get(key);
        if(old) {old.from=Math.min(old.from,t);old.to=Math.max(old.to,next);}
        else groups.set(key,{tr:tr.key,ids,from:t,to:next});
      }
    }
  }
  return {groups:[...groups.values()],spatialChecks,covered,temporalWindows};
}

function countMembership(reqs,groups) {
  const seen=new Set();
  let biggest=0;
  for(const g of groups) {biggest=Math.max(biggest,g.ids.length);for(const id of g.ids)seen.add(id);}
  return {biggest,sharedRequests:seen.size,singletons:reqs.length};
}

function representation(candidates,groups) {
  let covered=0, missing=0, singles=0, shared=0;
  const examples=[];
  for(const c of candidates) {
    const seeds=[...new Set(c.seeds.map(Number))];
    if(seeds.length===1) {singles++;covered++;continue;}
    shared++;
    const ok=groups.some(g=>seeds.every(id=>g.ids.includes(id)));
    if(ok)covered++;
    else {missing++;if(examples.length<3)examples.push({seeds,nodes:c.nodes});}
  }
  return {covered,missing,singles,shared,examples};
}

async function findV2() {
  const paths=[
    resolve(process.cwd(),'services/popbus/v2/model.js'),
    resolve(process.cwd(),'../services/popbus/v2/model.js'),
    resolve(process.cwd(),'../../services/popbus/v2/model.js')
  ];
  for(const p of paths) if(existsSync(p)) {
    try {const mod=await import(pathToFileURL(p).href);if(typeof mod.generaCandidate==='function')return {fn:mod.generaCandidate,path:p};}
    catch(e){return {error:`Import V2: ${e.message}`,path:p};}
  }
  return {error:'model.js non trovato: confronto V2 saltato'};
}

async function run(name,reqs,v2) {
  const t0=performance.now();
  const spatial=spatialTrajectories(reqs);
  const t1=performance.now();
  const temporal=buildGroups(reqs,spatial.trajectories);
  const t2=performance.now();
  const members=countMembership(reqs,temporal.groups);
  const maxSeed=Math.max(0,...temporal.groups.map(g=>g.ids.length));
  let v2info={status:'non_disponibile',candidate:null,v2_rappresentate:null,v2_non_rappresentate:null,esempi_mancanti:[],ms_v2:null};
  if(v2.fn) {
    const start=performance.now();
    try {
      // Deliberately bounded: protects test against V2 combinatorial explosion.
      const candidates=v2.fn(reqs,10000);
      const r=representation(candidates,temporal.groups);
      v2info={status:'ok',candidate:candidates.length,v2_rappresentate:r.covered,v2_non_rappresentate:r.missing,v2_singole:r.singles,esempi_mancanti:r.examples,ms_v2:round(performance.now()-start)};
    } catch(e) {
      v2info={status:'limite_o_errore',candidate:null,v2_rappresentate:null,v2_non_rappresentate:null,esempi_mancanti:[],errore_v2:e.message,ms_v2:round(performance.now()-start)};
    }
  }
  const out={scenario:name,richieste:reqs.length,candidate_singole_garantite:members.singletons,
    traiettorie_spaziali:spatial.trajectories.length,componenti_spaziali:spatial.merged,
    verifiche_copertura_spaziale:temporal.spatialChecks,richieste_coperte_su_traiettorie:temporal.covered,
    finestre_temporali_condivise:temporal.temporalWindows,insiemi_spaziotemporali:temporal.groups.length,
    gruppo_massimo:members.biggest,richieste_in_insiemi:members.sharedRequests,
    ms_spazio:round(t1-t0),ms_tempo_insiemi:round(t2-t1),ms_totale:round(t2-t0),
    heap_MB:round(process.memoryUsage().heapUsed/1048576),...v2info};
  console.log(JSON.stringify(out));
  if(members.singletons!==reqs.length)throw Error('Singole perse!');
  return out;
}

console.log('TURENTU - TEST SPAZIO -> TRAIETTORIE -> TEMPO -> INSIEMI');
console.log('SOLA LETTURA; nessun DB, routing o worker. 10 min/arco SINTETICI, tolleranza +/-30 min.');
console.log('Traiettorie: ancore delle richieste + unione di intervalli contigui per corridoio.');
console.log('Il confronto V2 verifica inclusione dei seed-set, NON parita di percorsi o fattibilita.');
const v2=await findV2();
console.log(v2.fn?`V2 importato: ${v2.path}`:`V2 non disponibile: ${v2.error}`);
await run('fixture_sovrapposta_sequenziale_e_fuori_orario',fixtures(),v2);
for(const mode of ['distribuito','concentrato']) {
  console.log('\nSCENARIO '+mode.toUpperCase());
  for(const count of CASES) await run(`${mode}_${count}`,makeRequests(count,mode),v2);
}
console.log('\nFINE TEST. Nessuna modifica a file o dati produttivi.');
console.log('LIMITI: percorso lineare per corridoio; tempi sintetici; gruppi massimali temporali su traiettorie costruite, non tutte le rotte possibili.');
console.log('Un seed-set V2 mancante NON dimostra una formazione reale persa; un seed-set rappresentato NON prova la fattibilita.');
