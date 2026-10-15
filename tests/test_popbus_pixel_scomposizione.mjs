// TURENTU POPBUS - TEST SPERIMENTALE PIXEL NODO x TEMPO
// SOLO MEMORIA - nessun DB, nessun worker, nessuna dipendenza
// Rinomina in test_popbus_pixel_scomposizione.mjs
// Esegui: node test_popbus_pixel_scomposizione.mjs
// Opzionale: node test_popbus_pixel_scomposizione.mjs 5
// Il numero opzionale indica la dimensione dei bucket temporali in minuti.
// ATTENZIONE: tempi di tratta SINTETICI, non provenienti dal planner.
// Questo test misura indicizzazione e sovrapposizioni POTENZIALI,
// NON dimostra compatibilita reale, parita V2 o velocita del matching completo.

import { performance } from 'node:perf_hooks';

const bucketMinutes = Number(process.argv[2] ?? 10);
if (!Number.isInteger(bucketMinutes) || bucketMinutes < 1 || bucketMinutes > 60) {
  throw new Error('Bucket temporale: intero tra 1 e 60 minuti');
}
const BUCKET_MS = bucketMinutes * 60_000;
const TOLLERANZA_MS = 30 * 60_000;
const BASE = Date.parse('2027-04-01T08:00:00Z');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Cinque direttrici con un nodo di interscambio comune (0).
// Ogni direttrice ha nodi numerati in modo univoco; i tempi di percorrenza
// sono artificialmente fissati a 10 minuti per segmento.
function network() {
  const routes = [];
  for (let d = 0; d < 5; d++) {
    routes.push([0, ...Array.from({ length: 20 }, (_, i) => 1 + d * 20 + i)]);
  }
  return routes;
}

function makeRequests(count, mode) {
  const rand = rng(12345 + count + (mode === 'concentrato' ? 1 : 0));
  const routes = network();
  const requests = [];
  for (let i = 0; i < count; i++) {
    const corridor = mode === 'concentrato' ? Math.floor(rand() * 2) : Math.floor(rand() * 5);
    const route = routes[corridor];
    const startIndex = Math.floor(rand() * 16);
    const span = 2 + Math.floor(rand() * 5);
    const path = route.slice(startIndex, startIndex + span + 1);
    // Concentrato: fascia 60 min; distribuito: fascia 12 ore.
    const minute = mode === 'concentrato' ? Math.floor(rand() * 60) : Math.floor(rand() * 720);
    requests.push({
      id: i + 1,
      corridor,
      path,
      start_datetime: BASE + minute * 60_000,
      posti_richiesti: 1 + Math.floor(rand() * 3),
    });
  }
  return requests;
}

function addToIndex(index, key, id) {
  let ids = index.get(key);
  if (!ids) { ids = new Set(); index.set(key, ids); }
  ids.add(id);
}

function indexPixels(requests) {
  const nodeIndex = new Map();
  const segmentIndex = new Map();
  let pixelMemberships = 0;
  let segmentMemberships = 0;
  for (const r of requests) {
    // In questo esperimento il tempo nominale di ogni segmento e 10 minuti.
    // Si indicizzano TUTTI i bucket che intersecano la finestra +/- 30 min.
    for (let i = 0; i < r.path.length; i++) {
      const nominal = r.start_datetime + i * 10 * 60_000;
      const first = Math.floor((nominal - TOLLERANZA_MS) / BUCKET_MS);
      const last = Math.floor((nominal + TOLLERANZA_MS) / BUCKET_MS);
      for (let b = first; b <= last; b++) {
        addToIndex(nodeIndex, `${r.path[i]}|${b}`, r.id);
        pixelMemberships++;
        if (i < r.path.length - 1) {
          // Segmento orientato, indicizzato per bucket di ingresso.
          addToIndex(segmentIndex, `${r.path[i]}>${r.path[i + 1]}|${b}`, r.id);
          segmentMemberships++;
        }
      }
    }
  }
  return { nodeIndex, segmentIndex, pixelMemberships, segmentMemberships };
}

function pairKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function overlappingPairs(index) {
  const pairs = new Set();
  let occupiedCells = 0;
  for (const ids of index.values()) {
    if (ids.size < 2) continue;
    occupiedCells++;
    const a = [...ids];
    for (let i = 0; i < a.length; i++) {
      for (let j = i + 1; j < a.length; j++) pairs.add(pairKey(a[i], a[j]));
    }
  }
  return { pairs, occupiedCells };
}

function timeIt(fn) {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t0 };
}

console.log('TURENTU - BENCHMARK SCOMPOSIZIONE PIXEL (DIAGNOSTICO)');
console.log(`Bucket=${bucketMinutes} min; tolleranza=+/-30 min; tempi sintetici=10 min/segmento`);
console.log('Nessuna chiamata al DB, al routing o al worker V2.');
console.log('');

for (const mode of ['distribuito', 'concentrato']) {
  console.log(`SCENARIO: ${mode.toUpperCase()}`);
  for (const count of [30, 100, 200, 500]) {
    const requests = makeRequests(count, mode);
    const built = timeIt(() => indexPixels(requests));
    const nodes = timeIt(() => overlappingPairs(built.result.nodeIndex));
    const segments = timeIt(() => overlappingPairs(built.result.segmentIndex));
    const allPairs = count * (count - 1) / 2;
    const n = nodes.result.pairs.size;
    const s = segments.result.pairs.size;
    // In questo test ogni coppia con segmento comune deve avere anche un nodo comune.
    const subset = [...segments.result.pairs].every(p => nodes.result.pairs.has(p));
    if (!subset) throw new Error('Errore indice: coppia segmento non presente nei nodi');
    console.log(JSON.stringify({
      richieste: count,
      ms_indicizzazione: +built.ms.toFixed(3),
      ms_coppie_nodo: +nodes.ms.toFixed(3),
      ms_coppie_segmento: +segments.ms.toFixed(3),
      celle_nodo: built.result.nodeIndex.size,
      celle_segmento: built.result.segmentIndex.size,
      presenze_pixel: built.result.pixelMemberships,
      presenze_segmento: built.result.segmentMemberships,
      celle_nodo_condivise: nodes.result.occupiedCells,
      coppie_totali_teoriche: allPairs,
      coppie_con_nodo_tempo_comune: n,
      coppie_con_segmento_tempo_comune: s,
      riduzione_confronti_coppie_pct: +(100 * (1 - s / allPairs)).toFixed(2),
      heap_MB: +(process.memoryUsage().heapUsed / 1048576).toFixed(2),
    }));
  }
  console.log('');
}
console.log('IMPORTANTE: la riduzione indica solo coppie prive di un segmento-tempo comune');
console.log('nel modello sintetico. NON e una riduzione sicura delle candidate V2.');
console.log('Una corsa puo collegare richieste consecutive senza segmento condiviso.');
console.log('Per validare il matching occorrono planner, percorsi reali e test di conservazione.');
