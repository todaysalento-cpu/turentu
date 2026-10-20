// Turentu POPBUS V2 — adapter di sola lettura PIXEL -> formazioni POPBUS.
// Non crea direttrici, non modifica il DB e non attiva missioni.
import { leggiOpportunitaPixel } from '../../pixel/pixel.persistence.service.js';
import { generaFormazioniAlternative } from './model.js';

const fail = message => { throw new Error(`PIXEL_POPBUS_ADAPTER: ${message}`); };
const id = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const millis = value => new Date(value).getTime();
const unique = xs => [...new Set(xs)];

export function normalizzaRichiestaPixelPopbus(row) {
  const start = id(row.start_node_id ?? row.origine_nodo_territoriale_id);
  const end = id(row.end_node_id ?? row.destinazione_nodo_territoriale_id);
  const requestId = id(row.id);
  if (!requestId || !start || !end || start === end) fail(`richiesta non valida: ${row.id}`);
  return { ...row, id: requestId, start_node_id: start, end_node_id: end };
}

export function adattaOpportunitaPixel(opportunita, richieste) {
  const opportunityId = id(opportunita?.pixel_opportunita_id);
  const corridorId = id(opportunita?.pixel_direttrice_id);
  if (!opportunityId || !corridorId) fail('identificativi opportunita/direttrice invalidi');
  if (!Array.isArray(opportunita.nodi) || opportunita.nodi.length < 2) fail('nodi mancanti');
  const nodes = opportunita.nodi.map(id);
  if (nodes.some(x => x === null) || unique(nodes).length !== nodes.length) fail('nodi duplicati/invalidi');
  const legs = opportunita.legs;
  if (!Array.isArray(legs) || legs.length !== nodes.length - 1 ||
      legs.some(l => !l || !Number.isFinite(Number(l.metres)) || Number(l.metres) < 0 ||
        !Number.isFinite(Number(l.seconds)) || Number(l.seconds) < 0 ||
        typeof l.polyline !== 'string' || !l.polyline.length)) fail('legs PIXEL incoerenti');
  const start = millis(opportunita.inizio_finestra);
  const end = millis(opportunita.fine_finestra);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) fail('finestra PIXEL invalida');
  if (!Array.isArray(opportunita.richiesta_ids) || !opportunita.richiesta_ids.length) fail('opportunita senza richieste');
  const ids = opportunita.richiesta_ids.map(id);
  if (ids.some(x => x === null) || unique(ids).length !== ids.length) fail('ID richieste duplicati/invalidi');
  const byId = new Map(richieste.map(r => {
    const normalized = normalizzaRichiestaPixelPopbus(r);
    return [normalized.id, normalized];
  }));
  const selected = ids.map(requestId => byId.get(requestId));
  if (selected.some(r => !r || r.stato !== 'in_attesa' || r.corsa_id != null))
    fail(`opportunita ${opportunityId}: richieste assenti, non in attesa o gia assegnate`);
  return {
    pixel_opportunita_id: opportunityId,
    pixel_direttrice_id: corridorId,
    versione: Number(opportunita.versione),
    plan: { nodes, legs },
    window: { start, end },
    richiesta_ids: ids,
    requests: selected,
    dati_temporali: opportunita.dati_temporali
  };
}

// Crea una candidata per seed e deduplica le formazioni equivalenti.
// I seed sono obbligatori nel model POPBUS: non passare tutti gli ID in una volta.
// L'opportunita rimane la fonte esclusiva del perimetro territoriale.
export function generaFormazioniDaOpportunitaPixel(contesto, { maxFormazioniPerSeed = 80 } = {}) {
  if (!Number.isSafeInteger(maxFormazioniPerSeed) || maxFormazioniPerSeed < 1 || maxFormazioniPerSeed > 1000)
    fail('maxFormazioniPerSeed invalido');
  const allowed = new Set(contesto.richiesta_ids);
  const seen = new Set();
  const result = [];
  for (const seed of contesto.richiesta_ids) {
    const alternatives = generaFormazioniAlternative(
      contesto.plan, contesto.requests, [seed], { maxFormazioni: maxFormazioniPerSeed }
    );
    for (const evaluation of alternatives) {
      const ids = evaluation.requests.map(r => id(r.id));
      if (!ids.length || ids.some(x => x === null || !allowed.has(x)))
        fail(`formazione fuori opportunita ${contesto.pixel_opportunita_id}`);
      if (!Number.isFinite(evaluation.departure) ||
          evaluation.departure < contesto.window.start ||
          evaluation.departure > contesto.window.end) continue;
      const key = `${ids.slice().sort((a, b) => a - b).join(',')}|${evaluation.departure}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        pixel_opportunita_id: contesto.pixel_opportunita_id,
        pixel_direttrice_id: contesto.pixel_direttrice_id,
        versione: contesto.versione,
        plan: contesto.plan,
        evaluation,
        richiesta_ids: ids
      });
    }
  }
  return result;
}

// Lettura con lo stesso client del chiamante, anche se e dentro una transazione.
// Fallisce in modo esplicito se il reader non restituisce tutte le richieste associate.
// Il limite del reader PIXEL e massimo 1000 opportunita per chiamata.
export async function leggiContestiOpportunitaPixel({ client, limit = 100, opportunityIds = null } = {}) {
  if (!client || typeof client.query !== 'function') fail('client PostgreSQL obbligatorio');
  const opportunities = await leggiOpportunitaPixel({ client, limit, opportunityIds });
  if (!opportunities.length) return [];
  const ids = unique(opportunities.flatMap(o => o.richiesta_ids.map(Number)));
  const { rows } = await client.query(
    `SELECT * FROM public.richieste_pop_bus WHERE id = ANY($1::bigint[])`, [ids]
  );
  return opportunities.map(o => adattaOpportunitaPixel(o, rows));
}
