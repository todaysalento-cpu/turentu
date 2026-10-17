// TURENTU PIXEL V1 — clustering temporale preliminare (sola memoria).
// NON certifica la compatibilita' di un percorso: quella richiede offset stradali
// reali ai nodi di salita e intersezionePartenze() di model.js.
import { normalizzaRichiesta, finestraSalita } from './model.js';

const MINUTO = 60_000;
const DEFAULTS = Object.freeze({
  tolleranzaMinuti: 30,
  maxTrasferimentoMinuti: 180,
  maxRichieste: 10000,
  maxCoppie: 2_000_000
});

function numeroNonNegativo(v, nome) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0) {
    throw new TypeError(`PIXEL_TEMPORAL: ${nome} non valido`);
  }
  return Number(v);
}
function interoPositivo(v, nome) {
  if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`PIXEL_TEMPORAL: ${nome} non valido`);
  return v;
}

/**
 * Pre-filtro conservativo: per una coppia di richieste, verifica se esiste
 * ALMENO un ordine di salita con un intervallo di viaggio possibile.
 * Non afferma che quell'ordine sia spazialmente o stradalmente realizzabile.
 * Un limite superiore troppo basso puo' produrre falsi negativi: configurarlo
 * in base al territorio e alla durata massima dei servizi da considerare.
 */
export function compatibilitaTemporalePreliminare(a, b, opzioni = {}) {
  const tolleranza = numeroNonNegativo(opzioni.tolleranzaMinuti ?? DEFAULTS.tolleranzaMinuti, 'tolleranzaMinuti');
  const maxMinuti = numeroNonNegativo(opzioni.maxTrasferimentoMinuti ?? DEFAULTS.maxTrasferimentoMinuti, 'maxTrasferimentoMinuti');
  const ra = normalizzaRichiesta(a);
  const rb = normalizzaRichiesta(b);
  const wa = finestraSalita(ra, tolleranza);
  const wb = finestraSalita(rb, tolleranza);
  const maxMs = maxMinuti * MINUTO;
  // Esiste un tA in wa e un tB in wb tali che 0 <= tB-tA <= maxMs,
  // oppure il viceversa. Le soste sono possibili ma non obbligatorie.
  const ab = wb.fine_ms >= wa.inizio_ms && wb.inizio_ms <= wa.fine_ms + maxMs;
  const ba = wa.fine_ms >= wb.inizio_ms && wa.inizio_ms <= wb.fine_ms + maxMs;
  return Object.freeze({
    compatibile: ab || ba,
    ordineAB: ab,
    ordineBA: ba,
    richiestaA: ra.id,
    richiestaB: rb.id,
    verificataSuStrada: false
  });
}

/**
 * Restituisce componenti connesse di potenziale compatibilita' temporale.
 * ATTENZIONE: una componente NON e' una formazione compatibile: la relazione
 * non e' transitiva (A~B e B~C non implica A~C). PIXEL spaziale e planner
 * devono verificare ogni candidata con gli offset reali.
 * Nessuna richiesta viene consumata, prenotata o modificata.
 */
export function raggruppaRichiesteTemporali(richieste, opzioni = {}) {
  if (!Array.isArray(richieste)) throw new TypeError('PIXEL_TEMPORAL: richieste deve essere un array');
  const maxRichieste = interoPositivo(opzioni.maxRichieste ?? DEFAULTS.maxRichieste, 'maxRichieste');
  const maxCoppie = interoPositivo(opzioni.maxCoppie ?? DEFAULTS.maxCoppie, 'maxCoppie');
  if (richieste.length > maxRichieste) throw new RangeError('PIXEL_TEMPORAL: limite richieste superato');
  const normalized = richieste.map(normalizzaRichiesta).sort((a, b) => a.start_datetime_ms - b.start_datetime_ms || a.id - b.id);
  if (new Set(normalized.map(r => r.id)).size !== normalized.length) throw new TypeError('PIXEL_TEMPORAL: ID richiesta duplicati');
  const parent = normalized.map((_, i) => i);
  function root(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a, b) { const x = root(a), y = root(b); if (x !== y) parent[Math.max(x, y)] = Math.min(x, y); }
  const tolleranza = numeroNonNegativo(opzioni.tolleranzaMinuti ?? DEFAULTS.tolleranzaMinuti, 'tolleranzaMinuti');
  const maxTrasferimento = numeroNonNegativo(opzioni.maxTrasferimentoMinuti ?? DEFAULTS.maxTrasferimentoMinuti, 'maxTrasferimentoMinuti');
  const horizonMs = (2 * tolleranza + maxTrasferimento) * MINUTO;
  let coppieValutate = 0;
  const coppie = [];
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (normalized[j].start_datetime_ms - normalized[i].start_datetime_ms > horizonMs) break;
      if (++coppieValutate > maxCoppie) throw new RangeError('PIXEL_TEMPORAL: limite coppie superato: suddividere il batch');
      const result = compatibilitaTemporalePreliminare(normalized[i], normalized[j], { tolleranzaMinuti: tolleranza, maxTrasferimentoMinuti: maxTrasferimento });
      if (result.compatibile) {
        union(i, j);
        coppie.push(Object.freeze({ a: result.richiestaA, b: result.richiestaB, ordineAB: result.ordineAB, ordineBA: result.ordineBA }));
      }
    }
  }
  const groups = new Map();
  normalized.forEach((r, i) => {
    const k = root(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  const fasce = [...groups.values()].map((items, i) => Object.freeze({
    id: `px-temporal-${i + 1}`,
    richiestaIds: Object.freeze(items.map(r => r.id)),
    inizio: new Date(Math.min(...items.map(r => r.start_datetime_ms - tolleranza * MINUTO))).toISOString(),
    fine: new Date(Math.max(...items.map(r => r.start_datetime_ms + tolleranza * MINUTO))).toISOString(),
    compatibilitaDaVerificareSuStrada: true
  }));
  return Object.freeze({
    fasce: Object.freeze(fasce),
    coppie: Object.freeze(coppie),
    coppieValutate,
    richiesteTotali: normalized.length,
    verificataSuStrada: false
  });
}
