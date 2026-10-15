// POPBUS V2 - GENERATORE TEMPORALE SPERIMENTALE, NON PRODUTTIVO
// Importare solo nei test. Nessuna modifica a model.js / worker.js.
// Restituisce tutte le candidate legacy, con una diagnosi temporale.
// NON scarta candidate: una candidata temporalmente incompatibile puo'
// ancora generare formazioni alternative compatibili.
import { generaCandidate, TOLLERANZA_MS } from './model.js';

export async function diagnosticaCandidateTemporali(requests, {
  roadSeconds, maxCandidate = 500, maxRoutingCalls = 500
} = {}) {
  if (typeof roadSeconds !== 'function') throw new TypeError('roadSeconds(a,b) obbligatoria');
  const candidates = generaCandidate(requests, maxCandidate);
  const byId = new Map(requests.map(r => [Number(r.id), r]));
  const cache = new Map();
  let routingCalls = 0, cacheHits = 0, indeterminate = 0;
  async function duration(a, b) {
    const key = `${a}>${b}`;
    if (cache.has(key)) { cacheHits++; return cache.get(key); }
    if (routingCalls >= maxRoutingCalls) return null;
    routingCalls++;
    let sec = null;
    try {
      const value = await roadSeconds(a, b);
      const v = Number(value);
      if (Number.isFinite(v) && v >= 0) sec = v;
    } catch { /* indeterminato: non scartare */ }
    cache.set(key, sec);
    return sec;
  }
  const details = [];
  for (const c of candidates) {
    let elapsed = 0;
    const offset = new Map([[Number(c.nodes[0]), 0]]);
    let known = true;
    for (let i = 1; i < c.nodes.length; i++) {
      const sec = await duration(Number(c.nodes[i - 1]), Number(c.nodes[i]));
      if (sec === null) { known = false; break; }
      elapsed += sec * 1000;
      offset.set(Number(c.nodes[i]), elapsed);
    }
    let lo = -Infinity, hi = Infinity;
    if (known) for (const id of c.seeds) {
      const r = byId.get(Number(id));
      const start = Number(r?.start_node_id);
      const time = Date.parse(r?.start_datetime);
      if (!r || !Number.isFinite(time) || !offset.has(start)) {
        known = false; break;
      }
      const projected = time - offset.get(start);
      lo = Math.max(lo, projected - TOLLERANZA_MS);
      hi = Math.min(hi, projected + TOLLERANZA_MS);
    }
    const seedTemporallyCompatible = known ? lo <= hi : null;
    if (!known) indeterminate++;
    details.push({
      nodes: c.nodes, seeds: c.seeds, classe: c.classe,
      seedTemporallyCompatible,
      // IMPORTANTE: non e' un'autorizzazione a eliminare la candidata.
      // generaFormazioniAlternative puo' utilizzare solo parte dei seed.
      safeToPruneWholeCandidate: false
    });
  }
  return {
    details,
    stats: {
      total: candidates.length,
      seedCompatible: details.filter(x => x.seedTemporallyCompatible === true).length,
      seedIncompatible: details.filter(x => x.seedTemporallyCompatible === false).length,
      indeterminate, routingCalls, cacheHits, cacheEntries: cache.size,
      productionPruned: 0
    }
  };
}
