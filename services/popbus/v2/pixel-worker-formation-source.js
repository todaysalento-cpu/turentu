// POPBUS V2: sorgente unica delle formazioni PIXEL, senza scritture.
// Da usare nel futuro ramo operativo PIXEL-first, NON nel generatore legacy.
import { leggiContestiOpportunitaPixel, generaFormazioniDaOpportunitaPixel } from './pixel-opportunity-adapter.js';

const fail = message => { throw new Error(`PIXEL_WORKER_SOURCE: ${message}`); };

export function preparaFormazioniPixel(contesti, { maxFormazioniPerSeed = 80, genera = generaFormazioniDaOpportunitaPixel } = {}) {
  if (!Array.isArray(contesti)) fail('contesti non validi');
  if (!Number.isSafeInteger(maxFormazioniPerSeed) || maxFormazioniPerSeed < 1 || maxFormazioniPerSeed > 1000) fail('limite formazioni invalido');
  const formazioni = [];
  const viste = new Set();
  for (const contesto of contesti) {
    if (!Number.isSafeInteger(contesto?.pixel_opportunita_id) || contesto.pixel_opportunita_id <= 0) fail('ID opportunita invalido');
    if (!Number.isSafeInteger(contesto?.pixel_direttrice_id) || contesto.pixel_direttrice_id <= 0) fail('ID direttrice invalido');
    if (!Number.isSafeInteger(contesto?.versione) || contesto.versione <= 0) fail('versione PIXEL invalida');
    const allowed = new Set(contesto.richiesta_ids);
    if (!allowed.size || allowed.size !== contesto.richiesta_ids.length) fail('richieste opportunita invalide');
    const generated = genera(contesto, { maxFormazioniPerSeed });
    if (!Array.isArray(generated)) fail('formazioni invalide');
    for (const f of generated) {
      if (Number(f.pixel_opportunita_id) !== contesto.pixel_opportunita_id ||
          Number(f.pixel_direttrice_id) !== contesto.pixel_direttrice_id ||
          Number(f.versione) !== contesto.versione) fail('provenienza PIXEL alterata');
      if (f.plan !== contesto.plan) fail('piano territoriale sostituito');
      const ids = f.evaluation?.requests?.map(r => Number(r.id));
      if (!Array.isArray(ids) || !ids.length || ids.some(id => !allowed.has(id)) || new Set(ids).size !== ids.length)
        fail('formazione contiene richieste estranee o duplicate');
      const departure = Number(f.evaluation.departure);
      if (!Number.isFinite(departure) || departure < contesto.window.start || departure > contesto.window.end)
        fail('partenza fuori finestra PIXEL');
      const key = `${contesto.pixel_opportunita_id}|${ids.slice().sort((a,b)=>a-b).join(',')}|${departure}`;
      if (viste.has(key)) continue;
      viste.add(key);
      formazioni.push(Object.freeze({
        pixelOpportunitaId: contesto.pixel_opportunita_id,
        pixelDirettriceId: contesto.pixel_direttrice_id,
        pixelVersione: contesto.versione,
        plan: contesto.plan,
        evaluation: f.evaluation,
        richiestaIds: Object.freeze(ids.slice()),
        source: 'PIXEL'
      }));
    }
  }
  return formazioni;
}

export async function leggiFormazioniPixelWorker({ client, limit = 100, maxFormazioniPerSeed = 80 } = {}) {
  if (!client || typeof client.query !== 'function') fail('client PostgreSQL obbligatorio');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('limite lettura invalido');
  const contesti = await leggiContestiOpportunitaPixel({ client, limit });
  // Non attivare un dataset che potrebbe essere troncato.
  if (contesti.length >= limit) fail('limite lettura raggiunto: dataset potenzialmente incompleto');
  return preparaFormazioniPixel(contesti, { maxFormazioniPerSeed });
}
