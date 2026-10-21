// TURENTU POPBUS V2 - Search multimission preview orchestrator (isolated).
// Install as services/popbus/v2/formation-multimission-search-preview.js
// No database access, writes, activation or bookable result.
import { costruisciMissioniPreviewPixel, validaMissioneSpostataPreview } from './formation-multimission-mission-builder.js';
import { ottimizzaAttesaDueMissioni } from './pixel-multimission-economic-time-optimizer.js';
import { anteprimaCicliMultimissione } from './formation-multimission-preview.js';

const fail = msg => { throw new Error(`MULTIMISSION_SEARCH_PREVIEW: ${msg}`); };
const isId = x => Number.isSafeInteger(Number(x)) && Number(x) > 0;
const hasAR = r => r?.ar_vincolata === true || r?.ar_vincolata === 'true' || r?.ar_group_id != null;

/**
 * The caller supplies a consistent, read-only snapshot of PIXEL contexts,
 * active nodes and eligible vehicles plus real operational callbacks.
 * virtualRequest must have an ID not used by any real request.
 * Never use this result to authorize bookings or create activation records.
 */
export async function anteprimaMultimissionePerSearch({
  contexts, nodesById, virtualRequest, vehicles, movement,
  isAvailable, hasConflicts, now = Date.now(),
  maxMissioni = 200, maxPairs = 1200, maxRoutingCalls = 100,
  costoAttesaOraEuro = 0, altriCostiEuro = 0, margineMinimoEuro = 0
} = {}) {
  if (!Array.isArray(contexts) || !(nodesById instanceof Map) ||
      !Array.isArray(vehicles) || typeof movement !== 'function' ||
      typeof isAvailable !== 'function' || typeof hasConflicts !== 'function' ||
      !isId(virtualRequest?.id) || hasAR(virtualRequest) ||
      !Number.isSafeInteger(maxPairs) || maxPairs < 1 ||
      !Number.isSafeInteger(maxRoutingCalls) || maxRoutingCalls < 1) fail('input non valido');
  const requestId = Number(virtualRequest.id);
  const missions = costruisciMissioniPreviewPixel({
    contexts, nodesById, virtualRequest, now, maxMissioni
  });
  const withUser = missions.filter(m => m.containsVirtualRequest);
  const withoutUser = missions.filter(m => !m.containsVirtualRequest);
  const cache = new Map();
  let routingCalls = 0, attempted = 0, recovered = 0;
  const route = async (from, to) => {
    const k = `${Number(from.lat)},${Number(from.lon)}>${Number(to.lat)},${Number(to.lon)}`;
    if (cache.has(k)) return cache.get(k);
    if (routingCalls >= maxRoutingCalls) fail('budget routing esaurito; nessun risultato parziale');
    routingCalls++;
    const v = await movement(from, to);
    if (!v || ![v.metres, v.seconds].every(x => x != null && Number.isFinite(Number(x)) && Number(x) >= 0))
      fail('routing invalido');
    const result = { metres: Number(v.metres), seconds: Number(v.seconds) };
    cache.set(k, result);
    return result;
  };
  const cycles = [];
  // Only one of the two missions may include the simulated passenger request.
  for (const userMission of withUser) {
    for (const otherMission of withoutUser) {
      for (const [a, b] of [[userMission, otherMission], [otherMission, userMission]]) {
        if (Number(a.departure) >= Number(b.departure)) continue;
        const ids = [...a.requests, ...b.requests].map(r => Number(r.id));
        if (new Set(ids).size !== ids.length || ids.filter(id => id === requestId).length !== 1) continue;
        if (a._rows.some(hasAR) || b._rows.some(hasAR)) continue;
        if (++attempted > maxPairs) fail('budget coppie esaurito; nessun risultato parziale');
        const optimized = await ottimizzaAttesaDueMissioni({
          a, b, movement: route, validateShiftedMission: validaMissioneSpostataPreview,
          costoAttesaOraEuro
        });
        if (!optimized.fattibile) continue;
        if (optimized.recuperata) recovered++;
        const out = await anteprimaCicliMultimissione({
          missions: [optimized.missione_a, optimized.missione_b],
          vehicles, movement: route, isAvailable, hasConflicts,
          validatePair: async (x, y) => {
            const pairIds = [...x.requests, ...y.requests].map(r => Number(r.id));
            return new Set(pairIds).size === pairIds.length &&
              pairIds.filter(id => id === requestId).length === 1 &&
              !x._rows.some(hasAR) && !y._rows.some(hasAR);
          },
          now, maxPairs: Math.max(1, vehicles.length),
          maxRoutingCalls, costoAttesaOraEuro, altriCostiEuro, margineMinimoEuro
        });
        for (const c of out.cicli) {
          if (!c.richiesta_ids.includes(requestId)) fail('ciclo privo di richiesta virtuale');
          cycles.push({ ...c, simulazione_non_prenotabile: true, attendibilita: 'indicativa' });
        }
      }
    }
  }
  cycles.sort((a, b) => a.deficit_lordo_euro - b.deficit_lordo_euro ||
    b.margine_euro - a.margine_euro || a.veicolo_id - b.veicolo_id);
  return {
    tipo: 'preview_multimissione', shadow: true, dbWrites: 0,
    simulazione_non_prenotabile: true, verifica_multimissione: true,
    missioni_valutate: missions.length, coppie_valutate: attempted,
    coppie_recuperate_temporalmente: recovered, routing_calls: routingCalls,
    cicli: cycles, migliore: cycles[0] ?? null
  };
}
