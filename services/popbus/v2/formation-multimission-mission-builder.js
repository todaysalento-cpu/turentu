// TURENTU POPBUS V2 - Mission builder PIXEL-first, read-only.
// Destination: services/popbus/v2/formation-multimission-mission-builder.js
// Does NOT activate bookings or certify live readiness.
import { generaFormazioniDaOpportunitaPixel } from './pixel-opportunity-adapter.js';
import { valutaRichieste, verificaQualitaRichieste, TOLLERANZA_MS } from './model.js';

const validId = v => Number.isSafeInteger(Number(v)) && Number(v) > 0;
const validMoney = v => v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
const linkedAR = r => r.ar_vincolata === true || r.ar_vincolata === 'true' || r.ar_group_id != null;
const fail = message => { throw new Error(`MULTIMISSION_MISSION_BUILDER: ${message}`); };

function temporalBounds(ctx, requests) {
  let lower = Number(ctx.window.start), upper = Number(ctx.window.end);
  let offset = 0;
  const offsets = new Map([[Number(ctx.plan.nodes[0]), 0]]);
  for (let i = 0; i < ctx.plan.legs.length; i++) {
    const seconds = Number(ctx.plan.legs[i].seconds);
    if (!Number.isFinite(seconds) || seconds < 0) fail('routing PIXEL invalido');
    offset += seconds * 1000;
    offsets.set(Number(ctx.plan.nodes[i + 1]), offset);
  }
  for (const r of requests) {
    const boardingOffset = offsets.get(Number(r.start_node_id));
    const desired = new Date(r.start_datetime).getTime();
    if (!Number.isFinite(boardingOffset) || !Number.isFinite(desired)) fail('orario salita invalido');
    lower = Math.max(lower, desired - boardingOffset - TOLLERANZA_MS);
    upper = Math.min(upper, desired - boardingOffset + TOLLERANZA_MS);
  }
  return lower <= upper ? {lower, upper, duration:offset} : null;
}

/**
 * Produce missioni validate per la preview, NON certificati di attivazione.
 * `contexts` are produced by leggiContestiOpportunitaPixel().
 * `nodesById` is Map<number,{lat,lon}> from active territorial nodes.
 * `virtualRequest` optional: user request with safe synthetic ID, price and nodes.
 * Linked A/R are excluded until a joint A/R validator is available.
 */
export function costruisciMissioniPreviewPixel({
  contexts, nodesById, virtualRequest = null, now = Date.now(),
  maxFormazioniPerSeed = 80, maxMissioni = 2000
} = {}) {
  if (!Array.isArray(contexts) || !(nodesById instanceof Map) ||
      !Number.isFinite(Number(now)) || !Number.isSafeInteger(maxMissioni) || maxMissioni < 1)
    fail('argomenti invalidi');
  if (virtualRequest && (!validId(virtualRequest.id) || !validMoney(virtualRequest.prezzo) ||
      !validId(virtualRequest.start_node_id) || !validId(virtualRequest.end_node_id) ||
      !Number.isSafeInteger(Number(virtualRequest.posti_richiesti)) || Number(virtualRequest.posti_richiesti) < 1 ||
      !Number.isFinite(new Date(virtualRequest.start_datetime).getTime())))
    fail('richiesta virtuale invalida');
  const realIds = new Set(contexts.flatMap(c => c.richiesta_ids.map(Number)));
  if (virtualRequest && realIds.has(Number(virtualRequest.id))) fail('ID virtuale in conflitto');
  const missions = [];
  const seen = new Set();
  for (const ctx of contexts) {
    if (!ctx?.plan?.nodes?.length || !Array.isArray(ctx.requests) || !ctx.window) fail('contesto PIXEL invalido');
    const eligible = ctx.requests.filter(r => !linkedAR(r));
    // A/R exclusion is fail-closed: do not silently omit one leg while keeping another.
    if (eligible.length !== ctx.requests.length) continue;
    const alternatives = generaFormazioniDaOpportunitaPixel(ctx, {maxFormazioniPerSeed});
    const options = alternatives.map(f => f.richiesta_ids);
    if (virtualRequest) {
      const s = ctx.plan.nodes.indexOf(Number(virtualRequest.start_node_id));
      const e = ctx.plan.nodes.indexOf(Number(virtualRequest.end_node_id));
      if (s >= 0 && e > s) {
        // Generate extra candidates including the user's virtual request.
        // Each seed represents an existing PIXEL request or the virtual request.
        for (const seed of [Number(virtualRequest.id), ...ctx.richiesta_ids.map(Number)]) {
          const evalResult = valutaRichieste(ctx.plan, [...eligible, virtualRequest], [seed], {
            departureWindow: ctx.window, includeIds: [Number(virtualRequest.id)]
          });
          if (evalResult) options.push(evalResult.requests.map(r => Number(r.id)));
        }
      }
    }
    const byId = new Map(eligible.map(r => [Number(r.id), r]));
    if (virtualRequest) byId.set(Number(virtualRequest.id), virtualRequest);
    for (const ids of options) {
      const uniqueIds = [...new Set(ids.map(Number))];
      if (uniqueIds.length !== ids.length) continue;
      const rows = uniqueIds.map(id => byId.get(id));
      if (rows.some(r => !r || !validMoney(r.prezzo))) continue;
      const evaluation = valutaRichieste(ctx.plan, rows, uniqueIds, {
        mode: 'seeds_only', departureWindow: ctx.window
      });
      if (!evaluation || evaluation.requests.length !== uniqueIds.length ||
          !verificaQualitaRichieste(ctx.plan, rows).ok) continue;
      const bounds = temporalBounds(ctx, rows);
      if (!bounds) continue;
      const departure = Math.max(bounds.lower, Math.min(bounds.upper, Number(evaluation.departure)));
      if (departure <= Number(now)) continue;
      const first = nodesById.get(Number(ctx.plan.nodes[0]));
      const last = nodesById.get(Number(ctx.plan.nodes.at(-1)));
      if (![first?.lat,first?.lon,last?.lat,last?.lon].every(v => v !== undefined && Number.isFinite(Number(v))))
        fail('coordinate nodi mancanti');
      const key = `${ctx.pixel_opportunita_id}|${uniqueIds.slice().sort((a,b)=>a-b).join(',')}|${departure}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (missions.length >= maxMissioni) fail('budget missioni superato, nessun risultato parziale');
      missions.push({
        pixelOpportunitaId: Number(ctx.pixel_opportunita_id),
        pixelDirettriceId: Number(ctx.pixel_direttrice_id),
        from: {lat:Number(first.lat),lon:Number(first.lon)},
        to: {lat:Number(last.lat),lon:Number(last.lon)},
        departure, arrival: departure + bounds.duration,
        lower: bounds.lower, upper: bounds.upper,
        kmMissione: ctx.plan.legs.reduce((sum,l)=>sum+Number(l.metres),0)/1000,
        peak: Number(evaluation.peak),
        requests: rows.map(r=>({id:Number(r.id),prezzo:Number(r.prezzo)})),
        requestIds: uniqueIds,
        containsVirtualRequest: !!virtualRequest && uniqueIds.includes(Number(virtualRequest.id)),
        validated: true,
        // Keep internal references only; never serialize to a public response.
        _ctx: ctx, _rows: rows
      });
    }
  }
  return missions;
}

/** Revalidate a shifted departure against the exact per-passenger pickup windows. */
export async function validaMissioneSpostataPreview(shifted, original) {
  if (!shifted || !original?._ctx || !Array.isArray(original._rows)) return false;
  const bounds = temporalBounds(original._ctx, original._rows);
  if (!bounds || !Number.isFinite(Number(shifted.departure))) return false;
  if (Number(shifted.departure) < bounds.lower || Number(shifted.departure) > bounds.upper) return false;
  if (Math.abs(Number(shifted.arrival) - Number(shifted.departure) - bounds.duration) > 1) return false;
  const check = valutaRichieste(original._ctx.plan, original._rows,
    original._rows.map(r=>Number(r.id)), {mode:'seeds_only', departureWindow:{start:Number(shifted.departure),end:Number(shifted.departure)}});
  return !!check && check.requests.length === original._rows.length &&
    verificaQualitaRichieste(original._ctx.plan, original._rows).ok;
}
