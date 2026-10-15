// TURENTU POPBUS - TEST COPERTURA COMPLETA PIXEL SPAZIO-TEMPORALI
// Salvare come tests/test_popbus_copertura_pixel.mjs
// Eseguire: node tests/test_popbus_copertura_pixel.mjs
// Opzionale: node tests/test_popbus_copertura_pixel.mjs 5
// NON importa il worker, NON legge/scrive DB, NON chiama routing.
// Tempi di viaggio sintetici: 10 minuti per segmento; tolleranza +/-30 min.
// IMPORTANTE: confronto con un ORACOLO SINTETICO, NON con il planner POPBUS V2.

import { performance } from 'node:perf_hooks';

const BUCKET_MIN = Number(process.argv[2] ?? 10);
if (!Number.isInteger(BUCKET_MIN) || BUCKET_MIN < 1 || BUCKET_MIN > 60) {
  console.error('Bucket non valido: scegliere un intero tra 1 e 60 minuti');
  process.exit(1);
}
const MIN = 60_000;
const LEG_MIN = 10;
const TOL_MIN = 30;
const BASE = Date.UTC(2027, 3, 1, 8, 0);
const key = (a, b, bucket) => `${a}>${b}@${bucket}`;
const bucketOf = ms => Math.floor(ms / (BUCKET_MIN * MIN));
const range = n => Array.from({ length: n }, (_, i) => i);
const rnd = (seed => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; })(20261014);

// Ogni richiesta percorre un sottopercorso lineare di una direttrice.
// Le direttrici sono volutamente disgiunte: nessun collegamento inter-direttrice inventato.
function requestsFor(n, scenario) {
  const result = [];
  const corridors = scenario === 'distribuito' ? 16 : 2;
  for (let i = 0; i < n; i++) {
    const corridor = Math.floor(rnd() * corridors);
    const start = Math.floor(rnd() * 16);
    const length = 2 + Math.floor(rnd() * 5);
    const nodes = range(length + 1).map(k => corridor * 100 + start + k);
    const slot = scenario === 'distribuito' ? Math.floor(rnd() * 72) : Math.floor(rnd() * 9);
    result.push({ id: i + 1, nodes, startMs: BASE + slot * 10 * MIN, posti: 1 + Math.floor(rnd() * 3) });
  }
  return result;
}

// Proietta TUTTI i segmenti della richiesta su TUTTI i bucket temporalmente
// possibili (inclusi estremi). Si allarga di un bucket per evitare falsi
// negativi al confine; il controllo esatto successivo elimina i falsi positivi.
function buildIndex(requests) {
  const index = new Map();
  let presenze = 0;
  for (const r of requests) {
    for (let j = 0; j < r.nodes.length - 1; j++) {
      const t = r.startMs + j * LEG_MIN * MIN;
      const lo = bucketOf(t - TOL_MIN * MIN) - 1;
      const hi = bucketOf(t + TOL_MIN * MIN) + 1;
      for (let b = lo; b <= hi; b++) {
        const k = key(r.nodes[j], r.nodes[j + 1], b);
        if (!index.has(k)) index.set(k, new Set());
        index.get(k).add(r.id);
        presenze++;
      }
    }
  }
  return { index, presenze };
}

// Corsa candidata: nodi ordinati e ora di partenza effettiva.
// L'indice inverso trova richieste con almeno un segmento coincidente.
// La verifica COMPLETA richiede che tutti i segmenti della richiesta siano
// coperti, nell'ordine, con lo stesso scostamento temporale ammissibile.
function matchesPixel(candidate, index, byId) {
  const potential = new Set();
  for (let j = 0; j < candidate.nodes.length - 1; j++) {
    const t = candidate.departure + j * LEG_MIN * MIN;
    const ids = index.get(key(candidate.nodes[j], candidate.nodes[j + 1], bucketOf(t)));
    if (ids) for (const id of ids) potential.add(id);
  }
  const accepted = [];
  for (const id of potential) {
    const r = byId.get(id);
    if (fullCoverage(candidate, r)) accepted.push(id);
  }
  return { ids: accepted.sort((a, b) => a - b), prefiltered: potential.size };
}

function fullCoverage(candidate, request) {
  if (request.nodes.length > candidate.nodes.length) return false;
  // Il percorso della richiesta deve apparire per intero, in sequenza.
  // Questo prototipo usa tratte lineari senza deviazioni intermedie.
  outer: for (let i = 0; i <= candidate.nodes.length - request.nodes.length; i++) {
    for (let j = 0; j < request.nodes.length; j++) {
      if (candidate.nodes[i + j] !== request.nodes[j]) continue outer;
    }
    const pickup = candidate.departure + i * LEG_MIN * MIN;
    if (Math.abs(pickup - request.startMs) <= TOL_MIN * MIN) return true;
  }
  return false;
}

// Oracolo indipendente dall'indice: scansione completa delle richieste.
function matchesOracle(candidate, requests) {
  return requests.filter(r => fullCoverage(candidate, r)).map(r => r.id).sort((a, b) => a - b);
}

function candidatesFor(requests) {
  const candidates = [];
  for (const r of requests) {
    // Tre orari possibili, sempre su un percorso realmente presente nel dataset.
    for (const shift of [-20, 0, 20]) {
      candidates.push({ nodes: r.nodes, departure: r.startMs + shift * MIN });
    }
  }
  return candidates;
}

function run(n, scenario) {
  const requests = requestsFor(n, scenario);
  const byId = new Map(requests.map(r => [r.id, r]));
  const candidates = candidatesFor(requests);
  const t0 = performance.now();
  const { index, presenze } = buildIndex(requests);
  const t1 = performance.now();
  let checked = 0, prefiltered = 0, groups = 0, covered = 0;
  const found = [];
  for (const c of candidates) {
    const r = matchesPixel(c, index, byId);
    found.push(r.ids);
    prefiltered += r.prefiltered;
    covered += r.ids.length;
    if (r.ids.length >= 2) groups++;
    checked++;
  }
  const t2 = performance.now();
  let mismatches = 0;
  for (let i = 0; i < candidates.length; i++) {
    const oracle = matchesOracle(candidates[i], requests);
    if (oracle.join(',') !== found[i].join(',')) {
      mismatches++;
      if (mismatches <= 3) console.error('DIFFERENZA', i, 'pixel=', found[i], 'oracolo=', oracle);
    }
  }
  const t3 = performance.now();
  return {
    scenario, richieste: n, candidate_testate: checked,
    celle_segmento_tempo: index.size, presenze_pixel: presenze,
    ms_indicizzazione: +(t1 - t0).toFixed(3),
    ms_copertura_pixel: +(t2 - t1).toFixed(3),
    ms_oracolo_scansione: +(t3 - t2).toFixed(3),
    confronti_potenziali_pixel: prefiltered,
    confronti_oracolo: checked * requests.length,
    richieste_coperte_totali: covered,
    candidate_con_almeno_due_richieste: groups,
    differenze_vs_oracolo: mismatches,
    heap_MB: +(process.memoryUsage().heapUsed / 1048576).toFixed(2)
  };
}

console.log('TURENTU - TEST COPERTURA COMPLETA PIXEL');
console.log(`Bucket=${BUCKET_MIN} min; tolleranza=+/-${TOL_MIN} min; ${LEG_MIN} min/segmento (SINTETICI)`);
console.log('Solo memoria; nessuna chiamata a DB, routing o worker V2.');
let errors = 0;
for (const scenario of ['distribuito', 'concentrato']) {
  console.log(`\nSCENARIO: ${scenario.toUpperCase()}`);
  for (const n of [30, 100, 200, 500]) {
    const out = run(n, scenario);
    console.log(JSON.stringify(out));
    errors += out.differenze_vs_oracolo;
  }
}
console.log('\nNOTA: la parita vale solo rispetto all oracolo sintetico di questo test.');
console.log('Non dimostra parita con generaCandidate, planner o formazioni POPBUS V2.');
if (errors) {
  console.error(`TEST FALLITO: ${errors} differenze`);
  process.exitCode = 1;
} else {
  console.log('TEST SUPERATO: nessuna differenza nella copertura sintetica.');
}
