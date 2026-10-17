// TURENTU PIXEL — diagnosi completa dei gruppi temporali massimali.
// Nessun DB, assegnazione o prenotazione. I gruppi possono sovrapporsi.
// La complessita' di output puo' essere quadratica: usare su una direttrice
// e un intervallo temporale circoscritti, non sull'intera rete.
import { intersezionePartenze } from './model.js';

const freeze = a => Object.freeze(a);
const cmpId = (a,b) => String(a).localeCompare(String(b), 'en', {numeric:true});
export function gruppiTemporaliCompleti({ richieste, offsetSecondi, tolleranzaMinuti = 30 }) {
  if (!Array.isArray(richieste) || typeof offsetSecondi !== 'function' ||
      !Number.isFinite(tolleranzaMinuti) || tolleranzaMinuti < 0)
    throw new TypeError('PIXEL_TEMPORAL: parametri non validi');
  const seen = new Set();
  const intervals = richieste.map(r => {
    if (!r || seen.has(r.id)) throw new TypeError('PIXEL_TEMPORAL: richiesta assente o duplicata');
    seen.add(r.id);
    const offset = offsetSecondi(r);
    const territorial = r.start_node_id != null ? r : {
      ...r, start_node_id:r.origine_nodo_territoriale_id,
      end_node_id:r.destinazione_nodo_territoriale_id
    };
    const w = intersezionePartenze([{ richiesta:territorial, offsetSecondi:offset, tolleranzaMinuti }]);
    if (!w) throw new TypeError('PIXEL_TEMPORAL: intervallo non valido');
    return { r, start:w.inizio_ms, end:w.fine_ms };
  });
  // In un insieme di intervalli 1D, ogni gruppo compatibile ha un punto
  // comune. Basta esaminare i distinti estremi destri per ottenere tutti
  // i gruppi massimali, senza dipendere dall'ordine di arrivo.
  const endpoints = [...new Set(intervals.map(x => x.end))].sort((a,b)=>a-b);
  const candidates = [];
  const seenSets = new Set();
  for (const t of endpoints) {
    const active = intervals.filter(x=>x.start<=t && x.end>=t);
    if (!active.length) continue;
    const ids = active.map(x=>x.r.id).sort(cmpId);
    const key = JSON.stringify(ids);
    if (!seenSets.has(key)) {
      seenSets.add(key);
      candidates.push({ ids, active });
    }
  }
  const maximal = candidates.filter((a,i)=> !candidates.some((b,j)=>i!==j &&
    b.ids.length>a.ids.length && a.ids.every(id=>b.ids.includes(id))));
  return freeze(maximal.map(g => {
    const w = {
      inizioMs:Math.max(...g.active.map(x=>x.start)),
      fineMs:Math.min(...g.active.map(x=>x.end))
    };
    return freeze({ richiestaIds:freeze(g.ids), finestraPartenza:freeze(w),
      preliminare:true, massimaleTemporale:true });
  }).sort((a,b)=>a.finestraPartenza.inizioMs-b.finestraPartenza.inizioMs ||
    cmpId(a.richiestaIds[0],b.richiestaIds[0])));
}
