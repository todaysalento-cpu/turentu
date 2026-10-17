// TURENTU PIXEL -> POPBUS V2: adapter diagnostico, senza scritture DB.
// Importare da services/pixel/pixel-popbus-v2-adapter.js
import { valutaRichieste, verificaQualitaRichieste } from '../popbus/v2/model.js';

const ids = values => [...new Set(values.map(Number))];
const validPrice = r => r.prezzo != null && r.prezzo !== '' && Number.isFinite(Number(r.prezzo)) && Number(r.prezzo) >= 0;

/**
 * Valuta le istanze PIXEL tramite le regole di qualità e compatibilità POPBUS V2.
 * Non certifica disponibilità veicoli, ritorno base o sostenibilità economica.
 * Le richieste vanno fornite dal chiamante con prezzo e posti_richiesti reali.
 */
export async function diagnosticaPixelPopbusV2({ engine, direttriceId, richieste = [], bufferMinuti = 0 } = {}) {
  if (!engine || typeof engine.getCorridor !== 'function' ||
      typeof engine.temporalCandidatesCompleteWithReturns !== 'function') {
    throw new TypeError('PIXEL_POPBUS: engine PIXEL non valido');
  }
  const corridor = engine.getCorridor(direttriceId);
  if (!corridor) throw new Error('PIXEL_POPBUS: direttrice non trovata');
  const byId = new Map(richieste.map(r => [Number(r.id), r]));
  const instances = await engine.temporalCandidatesCompleteWithReturns(direttriceId, { bufferMinuti });
  const plan = { nodes: [...corridor.nodes], legs: [...corridor.legs] };
  return Object.freeze(instances.map((instance, indice) => {
    const requestIds = ids(instance.richiestaIds);
    const missing = requestIds.filter(id => !byId.has(id));
    const withoutPrice = requestIds.filter(id => byId.has(id) && !validPrice(byId.get(id)));
    const selected = requestIds.map(id => byId.get(id)).filter(Boolean);
    let evaluation = null;
    let quality = null;
    let motivo = null;
    if (missing.length) motivo = 'RICHIESTE_MANCANTI';
    else if (withoutPrice.length) motivo = 'PREZZI_MANCANTI';
    else {
      const incompatible = selected.some(r =>
        Number(r.start_node_id ?? r.origine_nodo_territoriale_id) !== Number(engine.getRequest(r.id)?.start_node_id) ||
        Number(r.end_node_id ?? r.destinazione_nodo_territoriale_id) !== Number(engine.getRequest(r.id)?.end_node_id));
      if (incompatible) motivo = 'NODI_RICHIESTA_INCOERENTI';
      else {
        const adapted = selected.map(r => ({ ...r,
          start_node_id: Number(r.start_node_id ?? r.origine_nodo_territoriale_id),
          end_node_id: Number(r.end_node_id ?? r.destinazione_nodo_territoriale_id) }));
        quality = verificaQualitaRichieste(plan, adapted);
        if (!quality.ok) motivo = quality.motivo;
        else {
          evaluation = valutaRichieste(plan, adapted, requestIds, { mode: 'seeds_only' });
          if (!evaluation || evaluation.requests.length !== requestIds.length) motivo = 'COMPATIBILITA_POPBUS_NON_SUPERATA';
        }
      }
    }
    return Object.freeze({
      direttriceId, istanzaIndice: indice, richiestaIds: Object.freeze(requestIds),
      compatibilePopbus: motivo === null, motivo,
      mancanti: Object.freeze(missing), senzaPrezzo: Object.freeze(withoutPrice),
      evaluation, qualita: quality,
      finestreRitornoPerNodo: instance.finestreRitornoPerNodo,
      attivabile: false,
      statoAttivazione: 'NON_VERIFICATO_VEICOLO_ECONOMIA_RITORNO_BASE'
    });
  }));
}
