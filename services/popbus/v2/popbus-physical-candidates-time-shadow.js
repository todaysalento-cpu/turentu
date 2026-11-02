import { diagnosticaDepartureFermate } from './popbus-stop-departure-optimizer.shadow.js';

const finite = x => typeof x === 'number' && Number.isFinite(x);

export function diagnosticaFinestreCandidatiFisiciShadow({ candidati, contexts } = {}) {
  if (!Array.isArray(candidati) || !Array.isArray(contexts)) throw new Error('TIME_SHADOW: input non valido');
  const finestrePixel = new Map();
  for (const ctx of contexts) {
    const id = Number(ctx.pixel_opportunita_id);
    const start = ctx.window?.start, end = ctx.window?.end;
    if (!Number.isSafeInteger(id) || id <= 0 || !finite(start) || !finite(end) || start > end || finestrePixel.has(id)) throw new Error('TIME_SHADOW: contesto PIXEL non valido');
    finestrePixel.set(id, { start, end, richieste: ctx.requests });
  }
  return candidati.map(candidato => {
    const ctx = finestrePixel.get(Number(candidato.pixelOpportunitaId));
    const itinerario = candidato.validazioneFisica?.itinerario;
    const ids = candidato.requests?.map(r => Number(r.id)) ?? [];
    const errore = motivo => ({ candidato, temporalShadow: { ok:false, motivo, attivabile:false } });
    if (!ctx || !itinerario?.ok || !Array.isArray(ctx.richieste)) return errore('DATI_INCOMPLETI');
    const richieste = ids.map(id => ctx.richieste.find(r => Number(r.id) === id));
    if (!ids.length || new Set(ids).size !== ids.length || richieste.some(r => !r)) return errore('RICHIESTE_NON_VALIDE');
    try {
      const diagnosi = diagnosticaDepartureFermate({ itinerario, richieste });
      const lower = Math.max(diagnosi.departureMin, ctx.start);
      const upper = Math.min(diagnosi.departureMax, ctx.end);
      const durataMs = itinerario.fineOperazioni - itinerario.departure;
      const ok = finite(lower) && finite(upper) && lower <= upper && finite(durataMs) && durataMs > 0;
      return { candidato, temporalShadow: { ok, motivo:ok ? 'FINESTRA_TEORICA_DISPONIBILE' : 'NESSUNA_INTERSEZIONE', lower:ok ? lower : null, upper:ok ? upper : null, durataMs:ok ? durataMs : null, pixelWindow:{start:ctx.start,end:ctx.end}, recuperabileValidato:false, attivabile:false } };
    } catch (error) {
      return { candidato, temporalShadow: { ok:false, motivo:'ERRORE_DIAGNOSTICA', errore:error.message, attivabile:false } };
    }
  });
}
