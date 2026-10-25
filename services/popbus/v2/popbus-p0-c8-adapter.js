// P0-C8.5 — Adattatore PURO per test PIXEL → POPBUS multimissione.
// Copiare in services/popbus/v2/popbus-p0-c8-adapter.js
// Nessuna query, scrittura, chiamata Stripe o modifica allo stato.
import {
  validaPianoMultiMissione,
  validaOccupazioneMultiMissione
} from './popbus-multimission-preflight.js';

const fail = (s) => { throw new Error(`P0-C8 ADAPTER: ${s}`); };
const positiveId = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0;
const positiveInteger = (v) => v != null && v !== '' && Number.isSafeInteger(Number(v)) && Number(v) >= 0;
const asMs = (v) => {
  const n = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(n) ? n : NaN;
};

/**
 * @param {object} options
 * @param {object} options.plan Output originale di componiCicloInCorsa().
 * @param {Array<object>} options.richiesteBloccate Righe reali DB, gia' bloccate dal chiamante.
 * @param {Array<object>} options.opportunitaMissioni Metadati PIXEL, uno per missione, stesso ordine:
 *   V1: {pixelOpportunitaId, corridoioPixelId?}.
 *   V2: {pixelOpportunitaId, corridoioPixelId, pixelDirettriceId,
 *        pixelVersione, nodiTerritoriali}. Non crea direttrici legacy.
 * @param {number} options.veicoloId
 * @param {number} options.postiTotali Capienza reale riletta dal DB.
 * @param {function} options.fingerprintRichiesta Funzione originale di request-fingerprint.js.
 * @param {object} options.economia Esito del validatore economico, calcolato sui dati reali
 *   {economicamenteAttivabile: true, ...}. L'adattatore NON lo ricalcola.
 * @returns {{piano:object, missioniPersistibili:Array<object>}}
 */
export function preparaCicloPixelPerPersistenza({
  plan, richiesteBloccate, opportunitaMissioni, veicoloId, postiTotali,
  fingerprintRichiesta, economia
}) {
  // Un contratto parzialmente marcato non deve ricadere silenziosamente in V1.
  const haSchema = plan?.schemaVersion != null;
  const haTipo = plan?.tipoItinerario != null;
  const v2 = Number(plan?.schemaVersion) === 2 &&
    plan?.tipoItinerario === 'FERMATE_FISICHE';
  if ((haSchema || haTipo) && !v2) {
    fail('contratto fisico V2 incompleto o non riconosciuto');
  }
  validaPianoMultiMissione(plan, { veicoloId, postiTotali });
  if (!Array.isArray(richiesteBloccate) ||
      richiesteBloccate.length !== plan.evaluation.requests.length) {
    fail('richieste DB incomplete');
  }
  if (!Array.isArray(opportunitaMissioni) ||
      opportunitaMissioni.length !== plan.missioni.length) {
    fail('metadati opportunita PIXEL incompleti');
  }
  if (typeof fingerprintRichiesta !== 'function') fail('funzione fingerprint mancante');
  if (economia?.economicamenteAttivabile !== true) {
    fail('ciclo non economicamente attivabile o economia non verificata');
  }
  const byId = new Map();
  for (const r of richiesteBloccate) {
    if (!positiveId(r?.id) || byId.has(Number(r.id))) fail('richiesta DB duplicata/non valida');
    if (r.stato !== 'in_lavorazione' || r.corsa_id != null) {
      fail(`richiesta ${r.id} non disponibile`);
    }
    if (!positiveId(r.cliente_id) || !positiveId(r.posti_richiesti) ||
        !Number.isFinite(Number(r.prezzo)) || Number(r.prezzo) < 0 ||
        !Number.isFinite(asMs(r.start_datetime))) {
      fail(`richiesta ${r.id} con dati incompleti`);
    }
    byId.set(Number(r.id), r);
  }
  const occupazione = validaOccupazioneMultiMissione(plan, richiesteBloccate, postiTotali);
  if (plan.evaluation.peak != null && Number(plan.evaluation.peak) !== occupazione.peak) {
    fail('picco assembler diverso dal DB');
  }
  const snapshot = [];
  for (const ref of plan.evaluation.requests) {
    const r = byId.get(Number(ref.id));
    if (!r) fail(`richiesta ${ref.id} assente`);
    const expected = Number(plan.evaluation.departure) + Number(plan.evaluation.times[ref.start]);
    if (Math.abs(asMs(r.start_datetime) - expected) > 1800000) {
      fail(`orario richiesta ${ref.id} fuori tolleranza`);
    }
    const fp = fingerprintRichiesta(r);
    if (typeof fp !== 'string' || !fp.length) fail(`fingerprint ${ref.id} non valido`);
    snapshot.push({ id: Number(ref.id), fingerprint: fp });
  }
  const missioniPersistibili = plan.missioni.map((m, i) => {
    const pix = opportunitaMissioni[i];
    if (!positiveId(pix?.pixelOpportunitaId)) fail(`opportunita PIXEL missione ${i + 1} assente`);
    if (v2) {
      if (!Array.isArray(pix.nodiTerritoriali) || pix.nodiTerritoriali.length < 2 ||
          !pix.nodiTerritoriali.every(positiveId)) {
        fail(`missione ${i + 1}: nodiTerritoriali mancanti o invalidi`);
      }
      if (!positiveId(pix.pixelDirettriceId)) {
        fail(`missione ${i + 1}: pixelDirettriceId mancante o invalido`);
      }
      if (!positiveInteger(pix.pixelVersione)) {
        fail(`missione ${i + 1}: pixelVersione mancante o invalida`);
      }
      if (typeof pix.corridoioPixelId !== 'string' || !pix.corridoioPixelId.trim()) {
        fail(`missione ${i + 1}: corridoioPixelId/engine ID mancante`);
      }
      if (m.corridoioPixelId != null && m.corridoioPixelId !== pix.corridoioPixelId) {
        fail(`missione ${i + 1}: engine ID discordante`);
      }
    }
    const s = Number(m.startIndex), e = Number(m.endIndex);
    const requests = plan.evaluation.requests
      .filter(r => r.start >= s && r.end <= e)
      .map(r => ({ id: Number(r.id), start: Number(r.start) - s, end: Number(r.end) - s }));
    if (!requests.length) fail(`missione ${i + 1} senza richieste`);
    const idsAttesi = new Set((m.richieste ?? []).map(Number));
    if (idsAttesi.size !== requests.length || requests.some(r => !idsAttesi.has(r.id))) {
      fail(`missione ${i + 1}: richieste non corrispondenti`);
    }
    return {
      pixelOpportunitaId: Number(pix.pixelOpportunitaId),
      ...(pix.corridoioPixelId == null ? {} : { corridoioPixelId: pix.corridoioPixelId }),
      ...(v2 ? {
        schemaVersion: 2,
        tipoItinerario: 'FERMATE_FISICHE',
        pixelDirettriceId: Number(pix.pixelDirettriceId),
        pixelVersione: Number(pix.pixelVersione),
        nodiTerritoriali: pix.nodiTerritoriali.map(Number)
      } : {}),
      nodes: plan.nodes.slice(s, e + 1),
      legs: plan.legs.slice(s, e),
      departure: Number(m.partenza),
      arrival: Number(m.arrivo),
      requests
    };
  });
  // Il piano globale resta nel formato atteso da acceptance.js.
  const piano = {
    ...plan,
    evaluation: { ...plan.evaluation, peak: occupazione.peak },
    requestSnapshot: snapshot,
    attivabile: false // La decisione di attivazione e' responsabilita' del workflow transazionale.
  };
  return { piano, missioniPersistibili };
}
