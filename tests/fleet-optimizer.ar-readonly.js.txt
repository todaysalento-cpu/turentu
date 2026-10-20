// ============================================================
// TURENTU POPBUS V2 — FLEET OPTIMIZER
// Modulo puro: nessun DB, routing, pagamento, socket o scrittura.
// Salva come services/popbus/v2/fleet-optimizer.js
// ============================================================

const DEFAULT_MAX_NODES = 250_000;
const DEFAULT_MAX_CANDIDATES = 5_000;
const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

function integerLimit(value, fallback, name) {
  const v = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(v) || v < 1) throw new Error(`${name} deve essere un intero positivo`);
  return v;
}

function toMillis(value) {
  const v = value instanceof Date ? value.getTime() :
    typeof value === 'string' && !/^\d+$/.test(value) ? Date.parse(value) : Number(value);
  return Number.isFinite(v) ? v : NaN;
}

function euroToCents(value, name) {
  const v = Number(value);
  if (!Number.isFinite(v) || Math.abs(v) > MAX_SAFE_CENTS / 100) {
    throw new Error(`${name} non valido`);
  }
  const cents = Math.round((v + Math.sign(v) * Number.EPSILON) * 100);
  if (!Number.isSafeInteger(cents)) throw new Error(`${name} fuori intervallo`);
  return cents;
}

function candidateIds(candidate) {
  const raw = candidate.richieste ?? candidate.evaluation?.requests;
  if (!Array.isArray(raw)) throw new Error('richieste mancanti');
  const ids = raw.flat(Infinity).map(x => typeof x === 'object' && x !== null ? x.id : x);
  if (!ids.length || ids.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new Error('ID richieste non validi');
  }
  const unique = ids.map(Number);
  if (new Set(unique).size !== unique.length) throw new Error('Richieste duplicate nella stessa candidata');
  return unique;
}

function normalize(candidate, index) {
  if (!candidate || typeof candidate !== 'object') throw new Error(`Candidata ${index}: oggetto non valido`);
  const vehicle = Number(candidate.veicolo ?? candidate.vehicle?.id);
  if (!Number.isSafeInteger(vehicle) || vehicle <= 0) throw new Error(`Candidata ${index}: veicolo non valido`);
  const requests = candidateIds(candidate);
  const start = toMillis(candidate.partenza_base ?? candidate.busyStart ?? candidate.busy_start);
  const end = toMillis(candidate.ritorno_base ?? candidate.busyEnd ?? candidate.busy_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error(`Candidata ${index}: intervallo base-base non valido`);
  }
  // Il margine DEVE essere gia' calcolato sull'intero ciclo:
  // base -> servizio -> eventuali trasferimenti -> base + eventuale attesa.
  const margin = candidate.margine_ciclo_con_attesa_euro ?? candidate.margine_euro;
  const cents = euroToCents(margin, `Candidata ${index}: margine`);
  return { candidate, index, vehicle, requests, start, end, cents };
}

// Modalita A/R opt-in: options.arPairs = [{andata: 101, ritorno: 201}, ...].
// Il chiamante deve fornire TUTTE le coppie vincolate presenti nei candidati.
function normalizeArPairs(pairs) {
  if (!Array.isArray(pairs)) throw new Error('arPairs deve essere un array');
  const partner = new Map();
  for (const [i, pair] of pairs.entries()) {
    const a = Number(pair?.andata);
    const r = Number(pair?.ritorno);
    if (![a, r].every(x => Number.isSafeInteger(x) && x > 0) || a === r ||
        partner.has(a) || partner.has(r)) {
      throw new Error(`arPairs[${i}]: coppia non valida o richiesta riutilizzata`);
    }
    partner.set(a, r);
    partner.set(r, a);
  }
  return partner;
}

function ottimizzaFlottaAr(candidati, options) {
  const maxNodi = integerLimit(options.maxNodi, DEFAULT_MAX_NODES, 'maxNodi');
  const maxCandidati = integerLimit(options.maxCandidati, DEFAULT_MAX_CANDIDATES, 'maxCandidati');
  const partner = normalizeArPairs(options.arPairs);
  // Non eliminare margini negativi: una tratta in perdita puo' essere
  // indispensabile per rendere ammissibile una coppia A/R globalmente redditizia.
  const normalized = candidati.map(normalize);
  // Il troncamento puo' compromettere la completezza: in modalita A/R
  // rifiutiamo risultati parziali anziche' dichiararli utilizzabili.
  if (normalized.length > maxCandidati) {
    throw new Error('AR_CANDIDATI_LIMIT: aumentare maxCandidati o ridurre input; nessuna selezione sicura');
  }
  normalized.sort((a, b) => b.cents - a.cents || a.index - b.index);
  const n = normalized.length;
  const conflicts = Array.from({length:n}, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = normalized[i], b = normalized[j];
      if (a.requests.some(id => b.requests.includes(id)) ||
          (a.vehicle === b.vehicle && a.start < b.end && b.start < a.end)) {
        conflicts[i].push(j);
      }
    }
  }
  const suffix = new Array(n+1).fill(0);
  for (let i=n-1;i>=0;i--) {
    suffix[i] = suffix[i+1] + Math.max(0, normalized[i].cents);
    if (!Number.isSafeInteger(suffix[i])) throw new Error('Somma margini fuori intervallo sicuro');
  }
  const forbidden = new Uint32Array(n);
  const chosen = [];
  const covered = new Set();
  let best=0, bestIndices=[], visited=0, limitReached=false;
  function complete() {
    for (const id of covered) if (partner.has(id) && !covered.has(partner.get(id))) return false;
    return true;
  }
  function dfs(i, score) {
    if (visited >= maxNodi) {limitReached=true;return;}
    visited++;
    if (score > best && complete()) {best=score;bestIndices=[...chosen];}
    if (i >= n || score + suffix[i] <= best) return;
    if (forbidden[i]===0) {
      chosen.push(i);
      for (const id of normalized[i].requests) covered.add(id);
      for (const j of conflicts[i]) forbidden[j]++;
      dfs(i+1,score+normalized[i].cents);
      for (const j of conflicts[i]) forbidden[j]--;
      for (const id of normalized[i].requests) covered.delete(id);
      chosen.pop();
    }
    if (!limitReached) dfs(i+1,score);
  }
  dfs(0,0);
  // Fail-closed: un limite di ricerca non consente di certificare il piano A/R.
  if (limitReached) throw new Error('AR_NODI_LIMIT: ricerca incompleta; nessuna selezione attivabile');
  const selected=bestIndices.map(i=>normalized[i]);
  const ids=[...new Set(selected.flatMap(x=>x.requests))].sort((a,b)=>a-b);
  return {
    margineTotaleEuro:best/100,
    selezionati:selected.map(x=>x.candidate),
    cicliSelezionati:selected.length,
    richiesteCoperte:ids.length,
    richiesteIds:ids,
    veicoliUsati:[...new Set(selected.map(x=>x.vehicle))],
    nodiEsplorati:visited,
    candidatiAmmissibili:normalized.length,
    candidatiValutati:n,
    candidatiTagliati:0,
    limiteNodiRaggiunto:false,
    ottimoSulCampione:true,
    ottimoDimostrato:true,
    arVincoliApplicati:true,
    nota:'Ottimo solo sui candidati validati forniti. arPairs deve essere completo. Nessun commit o rivalidazione DB.'
  };
}

/**
 * Massimizza il margine complessivo dei candidati GIA' VALIDATI.
 * Non applica soglie commerciali, turni, pagamenti, qualita', raggio operativo
 * o conflitti DB: il chiamante deve verificarli PRIMA e rivalidarli al commit.
 *
 * Input: [{ veicolo, richieste: [[id,...],...], partenza_base,
 *           ritorno_base, margine_ciclo_con_attesa_euro }, ...]
 *
 * Un veicolo puo' effettuare piu' cicli se i relativi intervalli base-base
 * non si sovrappongono. Una richiesta puo' comparire in un solo ciclo.
 * In caso di limite raggiunto, restituisce la migliore soluzione trovata,
 * senza dichiararla ottima.
 */
export function ottimizzaFlotta(candidati, options = {}) {
  if (!Array.isArray(candidati)) throw new Error('candidati deve essere un array');
  if (Object.hasOwn(options, 'arPairs')) return ottimizzaFlottaAr(candidati, options);
  const maxNodi = integerLimit(options.maxNodi, DEFAULT_MAX_NODES, 'maxNodi');
  const maxCandidati = integerLimit(options.maxCandidati, DEFAULT_MAX_CANDIDATES, 'maxCandidati');
  const normalized = candidati.map(normalize).filter(x => x.cents > 0);
  normalized.sort((a, b) => b.cents - a.cents || a.index - b.index);
  const candidatiTagliati = Math.max(0, normalized.length - maxCandidati);
  const list = normalized.slice(0, maxCandidati);
  const n = list.length;

  const byRequest = new Map();
  const byVehicle = new Map();
  for (let i = 0; i < n; i++) {
    for (const id of list[i].requests) {
      if (!byRequest.has(id)) byRequest.set(id, []);
      byRequest.get(id).push(i);
    }
    const vehicle = list[i].vehicle;
    if (!byVehicle.has(vehicle)) byVehicle.set(vehicle, []);
    byVehicle.get(vehicle).push(i);
  }

  const conflicts = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const blocked = new Set();
    for (const id of list[i].requests) {
      for (const j of byRequest.get(id)) if (j > i) blocked.add(j);
    }
    for (const j of byVehicle.get(list[i].vehicle)) {
      if (j > i && list[i].start < list[j].end && list[j].start < list[i].end) {
        blocked.add(j);
      }
    }
    conflicts[i] = [...blocked];
  }

  const suffix = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    suffix[i] = suffix[i + 1] + list[i].cents;
    if (!Number.isSafeInteger(suffix[i])) throw new Error('Somma margini fuori intervallo sicuro');
  }

  // Uint32Array evita overflow dei contatori di esclusione a 16 bit.
  const forbidden = new Uint32Array(n);
  const chosen = [];
  let best = 0;
  let bestIndices = [];
  let visited = 0;
  let limitReached = false;

  function dfs(i, score) {
    if (visited >= maxNodi) { limitReached = true; return; }
    visited++;
    if (score > best) { best = score; bestIndices = [...chosen]; }
    if (i >= n || score + suffix[i] <= best) return;

    if (forbidden[i] === 0) {
      chosen.push(i);
      for (const j of conflicts[i]) forbidden[j]++;
      dfs(i + 1, score + list[i].cents);
      for (const j of conflicts[i]) forbidden[j]--;
      chosen.pop();
    }
    if (!limitReached) dfs(i + 1, score);
  }

  dfs(0, 0);
  const selected = bestIndices.map(i => list[i]);
  const ids = [...new Set(selected.flatMap(x => x.requests))].sort((a, b) => a - b);
  const ottimoSulCampione = !limitReached && candidatiTagliati === 0;

  return {
    margineTotaleEuro: best / 100,
    selezionati: selected.map(x => x.candidate),
    cicliSelezionati: selected.length,
    richiesteCoperte: ids.length,
    richiesteIds: ids,
    veicoliUsati: [...new Set(selected.map(x => x.vehicle))],
    nodiEsplorati: visited,
    candidatiAmmissibili: normalized.length,
    candidatiValutati: n,
    candidatiTagliati,
    limiteNodiRaggiunto: limitReached,
    ottimoSulCampione,
    ottimoDimostrato: ottimoSulCampione,
    nota: 'Ottimo solo rispetto ai candidati forniti e ai vincoli interni. Nessuna certificazione di attivabilita produttiva.'
  };
}

export default ottimizzaFlotta;
