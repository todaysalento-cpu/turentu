export const TOLLERANZA_MS = 30 * 60000;
const key = nodes => nodes.map(Number).join(':');
const MAX_SUBSETS = 500;
const EPS = 1e-8;

const requestId = r => Number(r.id);
const requestClass = r => String(r.classe || 'STANDARD').trim().toUpperCase();

// Candidate basate su richieste reali e concatenazioni dirette.
// Ogni richiesta singola rimane una candidata indipendente.
export function generaCandidate(requests, maxCandidate = 500) {
  const candidates = new Map();
  const queue = [];
  function add(nodes, seeds, classe) {
    if (new Set(nodes).size !== nodes.length) return;
    const uniqueSeeds = [...new Set(seeds.map(Number))];
    const k = `${classe}|${key(nodes)}|${uniqueSeeds.slice().sort((a, b) => a - b).join(',')}`;
    if (candidates.has(k)) return;
    if (candidates.size >= maxCandidate) throw new Error(`Limite ${maxCandidate} candidate: dividere il batch`);
    const c = { nodes, seeds: uniqueSeeds, classe };
    candidates.set(k, c);
    queue.push(c);
  }
  const valid = requests.filter(r =>
    Number.isInteger(requestId(r)) &&
    Number.isInteger(Number(r.start_node_id)) &&
    Number.isInteger(Number(r.end_node_id)) &&
    Number(r.start_node_id) !== Number(r.end_node_id)
  );
  for (const r of valid) add([Number(r.start_node_id), Number(r.end_node_id)], [requestId(r)], requestClass(r));
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    for (const r of valid) {
      if (requestClass(r) === c.classe && Number(r.start_node_id) === c.nodes.at(-1) && !c.seeds.includes(requestId(r))) {
        add([...c.nodes, Number(r.end_node_id)], [...c.seeds, requestId(r)], c.classe);
      }
    }
  }
  return [...candidates.values()];
}

// options:
//   mode: 'greedy' (default, compatibile con il worker esistente)
//       oppure 'seeds_only' (valuta soltanto le richieste indicate)
//   includeIds: elenco esplicito di richieste da valutare insieme ai seeds
//   maxPeak: capienza fisica massima durante l'aggregazione greedy
//   excludeIds: richieste da non aggregare
// Nessuna richiesta viene divisa tra veicoli.
export function valutaRichieste(plan, requests, seeds, options = {}) {
  const index = new Map(plan.nodes.map((id, i) => [Number(id), i]));
  if (index.size !== plan.nodes.length) return null;
  const times = [0];
  for (const segment of plan.legs) {
    if (!Number.isFinite(segment.seconds) || segment.seconds <= 0 ||
        !Number.isFinite(segment.metres) || segment.metres <= 0) throw new Error('Routing non valido');
    times.push(times.at(-1) + segment.seconds * 1000);
  }
  if (times.length !== plan.nodes.length) throw new Error('Piano incoerente');

  const eligible = requests.map(r => {
    const s = index.get(Number(r.start_node_id));
    const e = index.get(Number(r.end_node_id));
    const date = new Date(r.start_datetime).getTime();
    const posti = Number(r.posti_richiesti);
    const prezzo = Number(r.prezzo);
    if (s == null || e == null || s >= e || !Number.isFinite(date) ||
        !Number.isInteger(posti) || posti <= 0 || r.prezzo == null ||
        !Number.isFinite(prezzo) || prezzo < 0) return null;
    const base = date - times[s];
    return { r, s, e, lower: base - TOLLERANZA_MS, upper: base + TOLLERANZA_MS };
  }).filter(Boolean);

  const byId = new Map(eligible.map(x => [requestId(x.r), x]));
  const requiredIds = [...new Set([...(seeds || []), ...(options.includeIds || [])].map(Number))];
  const excluded = new Set((options.excludeIds || []).map(Number));
  const maxPeak = options.maxPeak == null ? Infinity : Number(options.maxPeak);
  if (maxPeak <= 0 || Number.isNaN(maxPeak)) return null;
  if (requiredIds.some(id => excluded.has(id))) return null;

  let lower = -Infinity;
  let upper = Infinity;
  const selected = [];
  const selectedIds = new Set();
  const occupancy = plan.legs.map(() => 0);

  function canAdd(x) {
    const l = Math.max(lower, x.lower);
    const u = Math.min(upper, x.upper);
    if (l > u) return false;
    for (let i = x.s; i < x.e; i++) {
      if (occupancy[i] + Number(x.r.posti_richiesti) > maxPeak) return false;
    }
    return true;
  }
  function add(x) {
    lower = Math.max(lower, x.lower);
    upper = Math.min(upper, x.upper);
    selected.push(x);
    selectedIds.add(requestId(x.r));
    for (let i = x.s; i < x.e; i++) occupancy[i] += Number(x.r.posti_richiesti);
  }

  for (const id of requiredIds) {
    const x = byId.get(id);
    if (!x || !canAdd(x)) return null;
    add(x);
  }

  if (options.mode !== 'seeds_only') {
    for (const x of eligible.sort((a, b) => requestId(a.r) - requestId(b.r))) {
      const id = requestId(x.r);
      if (selectedIds.has(id) || excluded.has(id)) continue;
      if (canAdd(x)) add(x);
    }
  }
  if (!selected.length) return null;
  const preferred = new Date(selected[0].r.start_datetime).getTime() - times[selected[0].s];
  const departure = Math.max(lower, Math.min(upper, preferred));
  return {
    departure,
    arrival: departure + times.at(-1),
    times,
    occupancy,
    peak: Math.max(0, ...occupancy),
    revenue: selected.reduce((sum, x) => sum + Math.round(Number(x.r.prezzo) * 100), 0) / 100,
    requests: selected.map(x => ({ id: requestId(x.r), start: x.s, end: x.e }))
  };
}

// Genera alternative di aggregazione per una candidata e un piano già calcolato.
// Mantiene obbligatori i seeds, e considera gruppi aggiuntivi in modo limitato.
// Il worker deve chiamare questa funzione e poi associare ogni alternativa ai veicoli.
export function generaFormazioniAlternative(plan, requests, seeds, options = {}) {
  const limit = Math.min(Math.max(1, Number(options.maxFormazioni) || 100), MAX_SUBSETS);
  const base = valutaRichieste(plan, requests, seeds, { mode: 'seeds_only' });
  if (!base) return [];
  const eligible = valutaRichieste(plan, requests, seeds, { mode: 'greedy' });
  const ids = (eligible?.requests || [])
    .map(r => r.id)
    .filter(id => !seeds.map(Number).includes(id));
  const alternatives = new Map();
  function record(extraIds) {
    const evaluation = valutaRichieste(plan, requests, seeds, {
      mode: 'seeds_only', includeIds: extraIds
    });
    if (!evaluation) return;
    const k = evaluation.requests.map(r => r.id).sort((a, b) => a - b).join(',');
    if (!alternatives.has(k)) alternatives.set(k, evaluation);
  }
  record([]);
  // Beam limit deterministico: considera prefissi e aggiunte singole;
  // non promette l'enumerazione completa dei sottoinsiemi.
  for (const id of ids) {
    if (alternatives.size >= limit) break;
    record([id]);
  }
  for (let i = 1; i <= ids.length && alternatives.size < limit; i++) {
    record(ids.slice(0, i));
  }
  if (eligible && alternatives.size < limit) {
    const k = eligible.requests.map(r => r.id).sort((a, b) => a - b).join(',');
    if (!alternatives.has(k)) alternatives.set(k, eligible);
  }
  return [...alternatives.values()];
}

function busyInterval(c) {
  const toMs = value => value instanceof Date ? value.getTime() :
    typeof value === 'string' && !/^\d+$/.test(value) ? new Date(value).getTime() : Number(value);
  const start = toMs(c.busyStart ?? c.busy_start ?? c.evaluation?.departure);
  const end = toMs(c.busyEnd ?? c.busy_end ?? c.evaluation?.arrival);
  return Number.isFinite(start) && Number.isFinite(end) && start < end
    ? { start, end } : null;
}
function overlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

// Selezione greedy deterministica di missioni già valutate e sostenibili.
// Consente più veicoli sulla stessa direttrice/fascia oraria.
// driver_id identifica il titolare della flotta, non il conducente operativo.
// Solo lo stesso veicolo non puo essere riutilizzato in intervalli sovrapposti
// (avvicinamento, percorso e ritorno inclusi).
export function scegliAttivazioni(candidates) {
  const busyRequests = new Set();
  const busyVehicles = new Map();
  const result = [];
  const sorted = [...candidates].sort((a, b) =>
    b.evaluation.requests.length - a.evaluation.requests.length ||
    (b.evaluation.revenue - b.cost) - (a.evaluation.revenue - a.cost) ||
    a.cost - b.cost ||
    key(a.plan.nodes).localeCompare(key(b.plan.nodes))
  );
  for (const c of sorted) {
    if (c.evaluation.revenue + EPS < c.cost ||
        c.evaluation.peak > Number(c.vehicle.posti_totali)) continue;
    if (c.evaluation.requests.some(r => busyRequests.has(r.id))) continue;
    const vehicleId = Number(c.vehicle.id);
    const interval = busyInterval(c);
    // Senza intervallo operativo completo, non riutilizzare il veicolo.
    const vehicleBookings = busyVehicles.get(vehicleId) || [];
    const conflicting = vehicleBookings.some(existing =>
      !interval || !existing || overlap(existing, interval)
    );
    if (conflicting) continue;
    result.push(c);
    c.evaluation.requests.forEach(r => busyRequests.add(r.id));
    busyVehicles.set(vehicleId, [...vehicleBookings, interval]);
  }
  return result;
}
