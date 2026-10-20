// Turentu — ponte PIXEL -> input di fattibilita POPBUS V2.
// Puro, senza query/scritture. Non e' un cutover operativo.
// Il worker deve ancora collegare questo output al suo ciclo veicoli/economia.
const fail = m => { throw new Error(`PIXEL_FEASIBILITY_BRIDGE: ${m}`); };
const validId = n => Number.isSafeInteger(Number(n)) && Number(n) > 0;

export function preparaInputFattibilitaPixel(formazioni, richieste, nodiTerritoriali) {
  if (!Array.isArray(formazioni) || !Array.isArray(richieste) || !Array.isArray(nodiTerritoriali)) fail('input non array');
  const byRequest = new Map();
  for (const r of richieste) {
    if (!validId(r?.id) || byRequest.has(Number(r.id))) fail('richieste duplicate o ID invalidi');
    byRequest.set(Number(r.id), r);
  }
  const nodeMap = new Map();
  for (const n of nodiTerritoriali) {
    if (!validId(n?.id) || nodeMap.has(Number(n.id))) fail('nodi duplicati o ID invalidi');
    nodeMap.set(Number(n.id), n);
  }
  return formazioni.map(f => {
    if (f?.source !== 'PIXEL' || !validId(f.pixelOpportunitaId) || !validId(f.pixelDirettriceId) ||
        !validId(f.pixelVersione)) fail('provenienza PIXEL mancante');
    const plan = f.plan;
    if (!Array.isArray(plan?.nodes) || plan.nodes.length < 2 ||
        !Array.isArray(plan.legs) || plan.legs.length !== plan.nodes.length - 1 ||
        plan.nodes.some(id => !validId(id))) fail('piano territoriale invalido');
    const coords = plan.nodes.map(id => nodeMap.get(Number(id)));
    if (coords.some(n => !n)) fail('nodo PIXEL intermedio assente dalla mappa');
    if (plan.legs.some(l => !l || !Number.isFinite(Number(l.seconds)) || Number(l.seconds) <= 0 ||
        !Number.isFinite(Number(l.metres)) || Number(l.metres) <= 0 ||
        typeof l.polyline !== 'string' || !l.polyline)) fail('tratta PIXEL senza routing verificato');
    const ev = f.evaluation;
    if (!Array.isArray(ev?.requests) || !ev.requests.length || !Array.isArray(f.richiestaIds) ||
        ev.requests.length !== f.richiestaIds.length ||
        !Number.isFinite(ev.departure) || !Number.isFinite(ev.arrival) || ev.arrival <= ev.departure ||
        !Array.isArray(ev.times) || ev.times.length !== plan.nodes.length ||
        ev.times[0] !== 0 || ev.times.some(t => !Number.isFinite(t) || t < 0) ||
        !Number.isFinite(ev.peak) || ev.peak < 1 || !Number.isFinite(ev.revenue)) fail('valutazione incompleta');
    const ids = ev.requests.map(x => Number(x.id));
    if (new Set(ids).size !== ids.length || new Set(f.richiestaIds.map(Number)).size !== ids.length ||
        ids.some(id => !f.richiestaIds.map(Number).includes(id))) fail('ID valutazione discordanti');
    const selected = ids.map(id => byRequest.get(id));
    if (selected.some(r => !r || r.stato !== 'in_attesa' || r.corsa_id != null)) fail('richiesta assente o non disponibile');
    for (let i = 0; i < plan.legs.length; i++) {
      const expected = ev.times[i] + Number(plan.legs[i].seconds) * 1000;
      if (Math.abs(ev.times[i + 1] - expected) > 1) fail('tempi non coerenti con tratte PIXEL');
    }
    for (let i = 0; i < ev.requests.length; i++) {
      const e = ev.requests[i], r = selected[i];
      const s = Number(e.start), d = Number(e.end);
      if (!Number.isSafeInteger(s) || !Number.isSafeInteger(d) || s < 0 || d <= s || d >= plan.nodes.length ||
          Number(r.start_node_id ?? r.origine_nodo_territoriale_id) !== Number(plan.nodes[s]) ||
          Number(r.end_node_id ?? r.destinazione_nodo_territoriale_id) !== Number(plan.nodes[d])) fail('salita/discesa discordante');
      if (Math.abs(new Date(r.start_datetime).getTime() - (ev.departure + ev.times[s])) > 30 * 60_000)
        fail('incompatibilita temporale al punto di salita');
    }
    return Object.freeze({
      source: 'PIXEL', pixelOpportunitaId: Number(f.pixelOpportunitaId),
      pixelDirettriceId: Number(f.pixelDirettriceId), pixelVersione: Number(f.pixelVersione),
      plan, evaluation: ev, selectedRequests: Object.freeze(selected),
      coordinates: Object.freeze(coords)
    });
  });
}
