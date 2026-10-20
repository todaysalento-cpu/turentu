// ============================================================
// TURENTU POPBUS V2 — MODEL
// Candidate, aggregazione, qualità individuale, selezione.
// Nessuna modifica al database. Nessuna gestione nuovi nodi.
// ============================================================

import { valutaEconomiaCiclo } from './cycle-pricing.js';

export const TOLLERANZA_MS = 30 * 60000;
const MAX_SUBSETS = 500;
const EPS = 1e-8;
const key = nodes => nodes.map(Number).join(':');
const requestId = r => Number(r.id);
const requestClass = r => String(r.classe || 'STANDARD').trim().toUpperCase();

// VALORI INIZIALI DI PROGETTO: da calibrare con test reali.
// La classe di percorrenza NON coincide con la classe commerciale
// (EXPRESS / STANDARD / SAVER).
export const QUALITA_PERCORRENZA = Object.freeze({
  BASSA: Object.freeze({ maxFermate: 10, minKmTraFermate: 2, maxDeviazionePct: 30 }),
  MEDIA: Object.freeze({ maxFermate: 5, minKmTraFermate: 10, maxDeviazionePct: 20 }),
  LUNGA: Object.freeze({ maxFermate: 2, minKmTraFermate: 35, maxDeviazionePct: 10 })
});

export const SOGLIE_PERCORRENZA_KM = Object.freeze({ bassaMax: 40, mediaMax: 150 });

function validId(v) { return Number.isSafeInteger(Number(v)) && Number(v) > 0; }
function validNode(v) { return Number.isSafeInteger(Number(v)); }
function uniqueIds(ids) { return [...new Set(ids.map(Number))]; }

// La distanza diretta è opzionale: se manca, la classe può essere
// esplicitamente salvata sulla richiesta oppure derivata dalla lunghezza
// della tratta sul piano corrente (stima conservativa, NON distanza diretta).
function directKm(r) {
  for (const v of [r.distanza_diretta_km, r.distanzaKmDiretta, r.distanza_km_diretta]) {
    if (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
  }
  return null;
}
function explicitDistanceClass(r) {
  const v = String(r.classe_percorrenza || r.tipo_percorrenza || '').trim().toUpperCase();
  return ['BASSA', 'MEDIA', 'LUNGA'].includes(v) ? v : null;
}
export function classePercorrenza(r, kmPercorso = null, soglie = SOGLIE_PERCORRENZA_KM) {
  const explicit = explicitDistanceClass(r);
  if (explicit) return explicit;
  const km = directKm(r) ?? kmPercorso;
  if (!Number.isFinite(km) || km <= 0) return null;
  if (km < soglie.bassaMax) return 'BASSA';
  if (km <= soglie.mediaMax) return 'MEDIA';
  return 'LUNGA';
}

// Ogni richiesta resta disponibile in TUTTE le candidate compatibili.
// Una richiesta di ritorno non viene mai marchiata come tale.
// La classe commerciale del candidato è quella del primo seed:
// i seed successivi possono avere classi commerciali differenti.
// Il worker NON deve più filtrare le richieste con r.classe === c.classe
// quando si desiderano candidate miste.
export function generaCandidate(requests, maxCandidate = 500) {
  const candidates = new Map();
  const queue = [];
  const limit = Number(maxCandidate);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('maxCandidate non valido');

  function add(nodes, seeds, classe) {
    if (new Set(nodes).size !== nodes.length) return;
    const uniqueSeeds = uniqueIds(seeds);
    const k = `${classe}|${key(nodes)}|${uniqueSeeds.slice().sort((a, b) => a - b).join(',')}`;
    if (candidates.has(k)) return;
    if (candidates.size >= limit) throw new Error(`Limite ${limit} candidate: dividere il batch`);
    const c = { nodes, seeds: uniqueSeeds, classe };
    candidates.set(k, c);
    queue.push(c);
  }

  const valid = requests.filter(r =>
    validId(r.id) && validNode(r.start_node_id) && validNode(r.end_node_id) &&
    Number(r.start_node_id) !== Number(r.end_node_id)
  );
  // Indice in memoria per nodo di partenza. Conserva l'ordine di valid:
  // la generazione e il limite candidate mantengono il comportamento originale.
  const richiestePerOrigine = new Map();
  for (const r of valid) {
    const origine = Number(r.start_node_id);
    if (!richiestePerOrigine.has(origine)) richiestePerOrigine.set(origine, []);
    richiestePerOrigine.get(origine).push(r);
  }

  for (const r of valid) add([Number(r.start_node_id), Number(r.end_node_id)], [requestId(r)], requestClass(r));

  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    const richiesteCompatibiliPerNodo = richiestePerOrigine.get(c.nodes.at(-1)) || [];
    for (const r of richiesteCompatibiliPerNodo) {
      if (!c.seeds.includes(requestId(r))) {
        add([...c.nodes, Number(r.end_node_id)], [...c.seeds, requestId(r)], c.classe);
      }
    }
  }
  return [...candidates.values()];
}

function buildGeometry(plan) {
  if (!Array.isArray(plan?.nodes) || !Array.isArray(plan?.legs) ||
      plan.nodes.length < 2 || plan.legs.length !== plan.nodes.length - 1) {
    throw new Error('Piano incoerente');
  }
  const times = [0];
  const metres = [0];
  for (const leg of plan.legs) {
    const normal = Number.isFinite(leg.seconds) && leg.seconds > 0 &&
      Number.isFinite(leg.metres) && leg.metres > 0;
    const verifiedCoincident = leg.roadCoincident === true &&
      leg.seconds === 0 && leg.metres === 0;
    if (!normal && !verifiedCoincident) {
      throw new Error('Routing non valido');
    }
    times.push(times.at(-1) + leg.seconds * 1000);
    metres.push(metres.at(-1) + leg.metres);
  }
  return { times, metres };
}

function qualityLimits(r, percorsoKm, options) {
  const config = options.qualityConfig || QUALITA_PERCORRENZA;
  const classe = classePercorrenza(r, percorsoKm, options.sogliePercorrenza || SOGLIE_PERCORRENZA_KM);
  if (!classe || !config[classe]) return null;
  const defaults = config[classe];
  const override = (value, fallback) => value == null ? fallback : Number(value);
  return {
    classe,
    maxFermate: override(r.max_fermate_intermedie, defaults.maxFermate),
    minKmTraFermate: override(r.min_km_tra_fermate, defaults.minKmTraFermate),
    maxDeviazionePct: override(r.max_deviazione_pct, defaults.maxDeviazionePct),
    maxRitardoMinuti: r.max_ritardo_minuti == null ? null : Number(r.max_ritardo_minuti)
  };
}

// Fermate commerciali = nodi di salita/discesa delle richieste
// effettivamente selezionate; i nodi di transito NON sono fermate.
// Il controllo avviene per ogni passeggero fra salita e discesa.
// Una distanza diretta assente NON viene inventata: il vincolo
// percentuale di deviazione viene verificato solo quando disponibile.
export function verificaQualitaRichieste(plan, requests, options = {}) {
  if (options.qualityEnabled === false) return { ok: true, dettagli: [] };
  const { metres, times } = buildGeometry(plan);
  const index = new Map(plan.nodes.map((id, i) => [Number(id), i]));
  // Il modello attuale richiede nodi unici; i cicli con nodi ripetuti
  // richiederanno occorrenze di fermata e non sono ancora supportati.
  if (index.size !== plan.nodes.length) return { ok: false, motivo: 'NODI_RIPETUTI' };

  const selected = [];
  for (const r of requests) {
    const s = index.get(Number(r.start_node_id));
    const e = index.get(Number(r.end_node_id));
    if (s == null || e == null || s >= e) return { ok: false, motivo: 'TRATTA_NON_PRESENTE', richiestaId: requestId(r) };
    selected.push({ r, s, e });
  }
  const stops = new Set(selected.flatMap(x => [x.s, x.e]));
  const dettagli = [];
  for (const x of selected) {
    const percorsoKm = (metres[x.e] - metres[x.s]) / 1000;
    // Una richiesta passeggeri con viaggio interamente nullo non è certificabile.
    if (percorsoKm <= 0) return { ok: false, motivo: 'TRATTA_PASSEGGERO_ZERO', richiestaId: requestId(x.r) };
    const limits = qualityLimits(x.r, percorsoKm, options);
    if (!limits) return { ok: false, motivo: 'CLASSE_PERCORRENZA_NON_DETERMINABILE', richiestaId: requestId(x.r) };
    if (![limits.maxFermate, limits.minKmTraFermate, limits.maxDeviazionePct].every(Number.isFinite) ||
        limits.maxFermate < 0 || limits.minKmTraFermate < 0 || limits.maxDeviazionePct < 0 ||
        (limits.maxRitardoMinuti != null && (!Number.isFinite(limits.maxRitardoMinuti) || limits.maxRitardoMinuti < 0))) {
      return { ok: false, motivo: 'CONFIG_QUALITA_NON_VALIDA', richiestaId: requestId(x.r) };
    }
    const intermediate = [...stops].filter(i => i > x.s && i < x.e).sort((a, b) => a - b);
    if (intermediate.length > limits.maxFermate) {
      return { ok: false, motivo: 'TROPPE_FERMATE', richiestaId: requestId(x.r), fermate: intermediate.length, massimo: limits.maxFermate };
    }
    // Distanza minima fra fermate commerciali consecutive durante il viaggio,
    // inclusi salita e discesa; non fra nodi puramente geometrici.
    const sequence = [x.s, ...intermediate, x.e];
    for (let j = 1; j < sequence.length; j++) {
      const km = (metres[sequence[j]] - metres[sequence[j - 1]]) / 1000;
      // Se non vi sono fermate intermedie, non penalizziamo una tratta
      // breve solo perché inferiore alla distanza minima della classe.
      if (intermediate.length && km + EPS < limits.minKmTraFermate) {
        return { ok: false, motivo: 'FERMATE_TROPPO_VICINE', richiestaId: requestId(x.r), km, minimoKm: limits.minKmTraFermate };
      }
    }
    const direttoKm = directKm(x.r);
    if (direttoKm != null && percorsoKm > direttoKm * (1 + limits.maxDeviazionePct / 100) + EPS) {
      return { ok: false, motivo: 'DEVIAZIONE_ECCESSIVA', richiestaId: requestId(x.r), percorsoKm, direttoKm };
    }
    // Tempo diretto disponibile soltanto se esplicitamente presente.
    const directSeconds = Number(x.r.tempo_diretto_secondi);
    if (limits.maxRitardoMinuti != null && x.r.tempo_diretto_secondi != null &&
        Number.isFinite(directSeconds) && directSeconds > 0 &&
        (times[x.e] - times[x.s]) / 1000 > directSeconds + limits.maxRitardoMinuti * 60) {
      return { ok: false, motivo: 'RITARDO_ECCESSIVO', richiestaId: requestId(x.r) };
    }
    dettagli.push({ richiestaId: requestId(x.r), classe: limits.classe, fermateIntermedie: intermediate.length, percorsoKm });
  }
  return { ok: true, dettagli };
}

// options: mode ('greedy' | 'seeds_only'), includeIds, excludeIds,
// maxPeak, qualityEnabled, qualityConfig, sogliePercorrenza.
// I limiti di qualità vengono verificati su TUTTE le richieste già
// selezionate ogni volta che si prova ad aggiungerne una nuova.
export function valutaRichieste(plan, requests, seeds, options = {}) {
  const index = new Map(plan.nodes.map((id, i) => [Number(id), i]));
  if (index.size !== plan.nodes.length) return null;
  const { times } = buildGeometry(plan);

  const eligible = requests.map(r => {
    const s = index.get(Number(r.start_node_id));
    const e = index.get(Number(r.end_node_id));
    const date = new Date(r.start_datetime).getTime();
    const posti = Number(r.posti_richiesti);
    const prezzo = Number(r.prezzo);
    if (!validId(r.id) || s == null || e == null || s >= e ||
        plan.legs.slice(s, e).every(l => l.roadCoincident === true) || !Number.isFinite(date) ||
        !Number.isInteger(posti) || posti <= 0 || r.prezzo == null ||
        !Number.isFinite(prezzo) || prezzo < 0) return null;
    const base = date - times[s];
    return { r, s, e, lower: base - TOLLERANZA_MS, upper: base + TOLLERANZA_MS };
  }).filter(Boolean);

  const byId = new Map(eligible.map(x => [requestId(x.r), x]));
  const requiredIds = uniqueIds([...(seeds || []), ...(options.includeIds || [])]);
  const excluded = new Set((options.excludeIds || []).map(Number));
  const maxPeak = options.maxPeak == null ? Infinity : Number(options.maxPeak);
  if (maxPeak <= 0 || Number.isNaN(maxPeak) || requiredIds.some(id => excluded.has(id))) return null;

  // Vincolo opzionale sulla partenza della direttrice (es. finestra PIXEL).
  // Senza departureWindow il comportamento preesistente resta invariato.
  const departureWindow = options.departureWindow;
  let lower = -Infinity;
  let upper = Infinity;
  if (departureWindow != null) {
    const start = Number(departureWindow.start);
    const end = Number(departureWindow.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      throw new Error('departureWindow non valida');
    }
    lower = start;
    upper = end;
  }
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
    return verificaQualitaRichieste(plan, [...selected.map(v => v.r), x.r], options).ok;
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
      if (!selectedIds.has(id) && !excluded.has(id) && canAdd(x)) add(x);
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
    // Metadati A/R trasportati senza alterare matching, ricavi o selezione.
    // Il vincolo di attivazione congiunta resta responsabilita' di POPBUS.
    requests: selected.map(x => ({
      id: requestId(x.r),
      start: x.s,
      end: x.e,
      ar_group_id: x.r.ar_group_id ?? null,
      ar_tratta: x.r.ar_tratta ?? null,
      ar_vincolata: x.r.ar_vincolata === true
    })),
    qualita: verificaQualitaRichieste(plan, selected.map(x => x.r), options).dettagli
  };
}

export function generaFormazioniAlternative(plan, requests, seeds, options = {}) {
  const limit = Math.min(Math.max(1, Number(options.maxFormazioni) || 100), MAX_SUBSETS);
  const opts = { ...options };
  const base = valutaRichieste(plan, requests, seeds, { ...opts, mode: 'seeds_only' });
  if (!base) return [];
  const eligible = valutaRichieste(plan, requests, seeds, { ...opts, mode: 'greedy' });
  const seedSet = new Set(seeds.map(Number));
  const ids = (eligible?.requests || []).map(r => r.id).filter(id => !seedSet.has(id));
  const alternatives = new Map();
  function record(extraIds) {
    const evaluation = valutaRichieste(plan, requests, seeds, { ...opts, mode: 'seeds_only', includeIds: extraIds });
    if (!evaluation) return;
    const k = evaluation.requests.map(r => r.id).sort((a, b) => a - b).join(',');
    if (!alternatives.has(k)) alternatives.set(k, evaluation);
  }
  record([]);
  for (const id of ids) {
    if (alternatives.size >= limit) break;
    record([id]);
  }
  for (let i = 1; i <= ids.length && alternatives.size < limit; i++) record(ids.slice(0, i));
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
  return Number.isFinite(start) && Number.isFinite(end) && start < end ? { start, end } : null;
}
function overlap(a, b) { return a.start < b.end && b.start < a.end; }

// Selezione economica netta, fail-closed: ogni candidato deve contenere
// componenti del ciclo complete e verificabili. Nessuna query o scrittura.
export function economiaCandidato(c) {
  if (!c || !Array.isArray(c.evaluation?.requests) || !c.evaluation.requests.length ||
      !Array.isArray(c.plan?.legs) || !c.plan.legs.length ||
      !c.approach || !c.returnTrip || !c.vehicle) return null;
  const nonNegativo = x => x != null && x !== '' && Number.isFinite(Number(x)) && Number(x) >= 0;
  if (![c.approach.metres, c.returnTrip.metres, c.vehicle.euro_km,
        ...c.plan.legs.map(l => l.metres)].every(nonNegativo)) return null;
  const prices = c.ricaviRichiesteEuro;
  if (!Array.isArray(prices) || prices.length !== c.evaluation.requests.length ||
      !prices.every(nonNegativo)) return null;
  try {
    const e = valutaEconomiaCiclo({
      ricaviRichiesteEuro: prices.map(Number),
      kmAvvicinamento: Number(c.approach.metres) / 1000,
      kmMissioni: c.plan.legs.reduce((s, l) => s + Number(l.metres), 0) / 1000,
      kmTrasferimenti: 0,
      kmRitornoBase: Number(c.returnTrip.metres) / 1000,
      euroKm: Number(c.vehicle.euro_km)
    });
    // I campi legacy devono coincidere con i valori ricalcolati.
    if (!nonNegativo(c.cost) || !nonNegativo(c.evaluation.revenue) ||
        Math.round(Number(c.cost) * 100) !== e.centesimi.costoCompleto ||
        Math.round(Number(c.evaluation.revenue) * 100) !== e.centesimi.ricavoLordo) return null;
    return e;
  } catch { return null; }
}

export function scegliAttivazioni(candidates) {
  const busyRequests = new Set();
  const busyVehicles = new Map();
  const result = [];
  const valid = candidates.map(c => ({ c, economy: economiaCandidato(c), interval: busyInterval(c) }))
    .filter(x => x.economy?.economicamenteAttivabile && x.interval &&
      x.interval.start > Date.now() &&
      Number.isSafeInteger(Number(x.c.vehicle?.id)) && Number(x.c.vehicle.id) > 0 &&
      Number.isInteger(Number(x.c.vehicle.posti_totali)) &&
      Number.isFinite(Number(x.c.evaluation?.peak)) &&
      Number(x.c.evaluation.peak) > 0 &&
      Number(x.c.evaluation.peak) <= Number(x.c.vehicle.posti_totali) &&
      x.c.evaluation.requests.every(r => Number.isSafeInteger(Number(r.id)) && Number(r.id) > 0));
  valid.sort((a, b) =>
    b.c.evaluation.requests.length - a.c.evaluation.requests.length ||
    b.economy.centesimi.margine - a.economy.centesimi.margine ||
    a.economy.centesimi.costoCompleto - b.economy.centesimi.costoCompleto ||
    key(a.c.plan.nodes).localeCompare(key(b.c.plan.nodes))
  );
  for (const { c, interval } of valid) {
    if (c.evaluation.requests.some(r => busyRequests.has(Number(r.id)))) continue;
    const vehicleId = Number(c.vehicle.id);
    const vehicleBookings = busyVehicles.get(vehicleId) || [];
    if (vehicleBookings.some(existing => overlap(existing, interval))) continue;
    result.push(c);
    c.evaluation.requests.forEach(r => busyRequests.add(Number(r.id)));
    busyVehicles.set(vehicleId, [...vehicleBookings, interval]);
  }
  return result;
}
