// PIXEL P2 - benchmark del motore REALE importato dal progetto.
// Nessun DB, rete, filesystem in scrittura o attivazione POPBUS.
// CMD: node tests\pixel_benchmark_P2_readonly.mjs --count=100 --seed=42
//      node tests\pixel_benchmark_P2_readonly.mjs --count=1000 --seed=42
//      node tests\pixel_benchmark_P2_readonly.mjs --count=5000 --seed=42 --maxCorridors=10000
//      node tests\pixel_benchmark_P2_readonly.mjs --count=10000 --seed=42 --maxCorridors=20000 --max-seconds=180
//      node tests\pixel_benchmark_P2_readonly.mjs --count=20000 --seed=42 --maxCorridors=30000 --max-seconds=300
import { performance } from 'node:perf_hooks';
import { createIncrementalCorridorEngine } from '../services/pixel/incremental-corridor-engine.js';

function option(name, fallback, min, max) {
  const raw = process.argv.find(s => s.startsWith(`--${name}=`));
  const value = raw ? Number(raw.slice(name.length + 3)) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`--${name} deve essere un intero tra ${min} e ${max}`);
  }
  return value;
}
const count = option('count', 100, 1, 50000);
const seed = option('seed', 42, 1, 2147483647);
const nodesCount = option('nodes', 80, 8, 500);
const maxVariants = option('variants', 4, 1, 100);
const maxNodes = option('max-nodes', 8, 2, 30);
// Supporta entrambe le sintassi CLI: --max-corridors e --maxCorridors.
const corridorFlags = process.argv.slice(2).filter(arg =>
  arg.startsWith('--max-corridors=') || arg.startsWith('--maxCorridors='));
if (corridorFlags.length > 1) {
  throw new Error('Specificare il limite direttrici una sola volta: --maxCorridors oppure --max-corridors');
}
const maxCorridors = corridorFlags.length
  ? (() => {
      const value = Number(corridorFlags[0].split('=')[1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 50000) {
        throw new Error('--maxCorridors deve essere un intero tra 1 e 50000');
      }
      return value;
    })()
  : 1500;
const maxSeconds = option('max-seconds', 45, 1, 3600);
const mode = process.argv.find(s => s.startsWith('--mode='))?.slice(7) ?? 'mixed';
if (!['mixed', 'concentrated', 'distributed'].includes(mode)) throw Error('mode: mixed, concentrated, distributed');

let state = seed;
function random() { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; }
function pick(n) { return Math.floor(random() * n); }
const start = Date.parse('2027-04-01T08:00:00.000Z');
const requests = Array.from({ length: count }, (_, i) => {
  let a, b;
  if (mode === 'concentrated' || (mode === 'mixed' && random() < 0.65)) {
    a = 1 + pick(Math.min(12, nodesCount - 1));
    b = Math.min(nodesCount, a + 1 + pick(Math.min(5, nodesCount - a)));
  } else {
    a = 1 + pick(nodesCount - 1);
    b = a + 1 + pick(nodesCount - a);
  }
  const minutes = pick(12 * 60);
  return { id: i + 1, origine_nodo_territoriale_id: a, destinazione_nodo_territoriale_id: b,
    start_datetime: new Date(start + minutes * 60000).toISOString(), posti_richiesti: 1 + pick(3) };
});
let routeCalls = 0;
let routedLegs = 0;
const routeNodes = async nodes => {
  routeCalls++;
  routedLegs += nodes.length - 1;
  return { verificataRouting: true, legs: nodes.slice(1).map((n, i) => ({
    metres: 1000 + Math.abs(n - nodes[i]) * 750,
    seconds: 180 + Math.abs(n - nodes[i]) * 75,
    polyline: `mock-${nodes[i]}-${n}`
  })) };
};
const engine = createIncrementalCorridorEngine({
  routeNodes, abilitaVariantiP1: true,
  maxVariantiPerRichiesta: maxVariants, maxNodiVariante: maxNodes
});
const latencies = [];
let processed = 0;
let error = null;
let stopReason = 'tutte le richieste elaborate';
const t0 = performance.now();
for (const req of requests) {
  if (processed > 0 && performance.now() - t0 >= maxSeconds * 1000) {
    stopReason = `limite tempo ${maxSeconds}s`; break;
  }
  if (engine.listCorridors().length >= maxCorridors) {
    stopReason = `limite direttrici ${maxCorridors}`; break;
  }
  const t = performance.now();
  try { await engine.processRequest(req); }
  catch (e) { error = `${e?.stack ?? e}`; stopReason = 'errore'; break; }
  latencies.push(performance.now() - t);
  processed++;
}
const elapsedMs = performance.now() - t0;
const corridors = engine.listCorridors();
const known = new Map(requests.slice(0, processed).map(r => [r.id, r]));
const covered = new Set();
const membershipErrors = [];
const signatures = new Set();
let duplicateGeometries = 0;
let associations = 0;
for (const c of corridors) {
  const signature = c.nodes.join('>');
  if (signatures.has(signature)) duplicateGeometries++;
  signatures.add(signature);
  const pos = new Map(c.nodes.map((id, idx) => [id, idx]));
  for (const id of c.richiestaIds) {
    associations++;
    const r = known.get(Number(id)) ?? known.get(id);
    if (!r || !(pos.has(r.origine_nodo_territoriale_id) && pos.has(r.destinazione_nodo_territoriale_id)
      && pos.get(r.origine_nodo_territoriale_id) < pos.get(r.destinazione_nodo_territoriale_id))) {
      if (membershipErrors.length < 10) membershipErrors.push({ corridor: c.id, request: id });
    } else covered.add(r.id);
  }
}
latencies.sort((a,b) => a-b);
const percentile = p => latencies.length ? Number(latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)].toFixed(2)) : null;
const heap = process.memoryUsage();
const report = {
  benchmark: 'PIXEL P2 motore incrementale reale / routing MOCK',
  params: { count, seed, nodesCount, mode, maxVariants, maxNodes, maxCorridors, maxSeconds },
  status: { processed, requested: count, complete: processed === count && !error, stopReason, error },
  performance: { elapsedMs: +elapsedMs.toFixed(2), throughputPerSecond: +(processed * 1000 / Math.max(1, elapsedMs)).toFixed(2),
    latencyMs: { p50: percentile(.50), p95: percentile(.95), p99: percentile(.99), max: percentile(1) },
    heapUsedMB: +(heap.heapUsed / 1048576).toFixed(2), rssMB: +(heap.rss / 1048576).toFixed(2) },
  routing: { calls: routeCalls, legs: routedLegs, callsPerRequest: +(routeCalls / Math.max(1, processed)).toFixed(2) },
  coverage: { corridors: corridors.length, uniqueGeometries: signatures.size, duplicateGeometries,
    coveredRequests: covered.size, uncoveredRequests: processed - covered.size,
    coveragePercent: +(100 * covered.size / Math.max(1, processed)).toFixed(2),
    associations, avgAssociationsPerCoveredRequest: +(associations / Math.max(1, covered.size)).toFixed(2),
    membershipErrors },
  warnings: [
    'Routing sintetico: NON misura rete stradale, latenze esterne o fattibilita POPBUS.',
    'Copertura: almeno una direttrice per richiesta, NON completezza di tutte le varianti.',
    'Limiti di tempo e direttrici sono controllati tra richieste, non interrompono una singola elaborazione.',
    'Nessuna scrittura DB. Le misure dipendono dalla macchina e dal carico.'
  ]
};
console.log(JSON.stringify(report, null, 2));
if (error || membershipErrors.length || duplicateGeometries || covered.size !== processed) process.exitCode = 1;
