// P0-C8.6 — Adattatore PURO PIXEL -> POPBUS multimissione V1/V2.
// Nessuna query, scrittura, chiamata Stripe o modifica allo stato.
import {
  validaPianoMultiMissione,
  validaOccupazioneMultiMissione
} from './popbus-multimission-preflight.js';

const fail = (s) => { throw new Error(`P0-C8 ADAPTER: ${s}`); };
const positiveId = (v) => v != null && v !== '' && Number.isSafeInteger(Number(v)) && Number(v) > 0;
const asMs = (v) => {
  const n = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Adatta un ciclo assemblato a un piano persistibile, senza eseguire scritture.
 * V2: i metadati PIXEL sono associati alle missioni PRIMA del preflight.
 */
export function preparaCicloPixelPerPersistenza({
  plan, richiesteBloccate, opportunitaMissioni, veicoloId, postiTotali,
  fingerprintRichiesta, economia
}) {
  const haSchema = plan?.schemaVersion != null;
  const haTipo = plan?.tipoItinerario != null;
  const v2 = Number(plan?.schemaVersion) === 2 &&
    plan?.tipoItinerario === 'FERMATE_FISICHE';
  if ((haSchema || haTipo) && !v2) {
    fail('contratto fisico V2 incompleto o non riconosciuto');
  }
  if (!plan || !Array.isArray(plan.missioni) || !plan.evaluation ||
      !Array.isArray(plan.evaluation.requests)) {
    fail('piano o missioni mancanti');
  }
  if (!Array.isArray(opportunitaMissioni) ||
      opportunitaMissioni.length !== plan.missioni.length) {
    fail('metadati opportunita PIXEL incompleti');
  }

  // Non mutare il piano dell'assembler. V1 conserva il proprio formato.
  // Il preflight V2 riceve già i metadati territoriali di ciascuna missione.
  const missioniComplete = v2 ? plan.missioni.map((m, i) => {
    const pix = opportunitaMissioni[i];
    if (!positiveId(pix?.pixelOpportunitaId)) {
      fail(`opportunita PIXEL missione ${i + 1} assente`);
    }
    if (!Array.isArray(pix.nodiTerritoriali) || pix.nodiTerritoriali.length < 2 ||
        !pix.nodiTerritoriali.every(positiveId)) {
      fail(`missione ${i + 1}: nodiTerritoriali mancanti o invalidi`);
    }
    if (!positiveId(pix.pixelDirettriceId)) {
      fail(`missione ${i + 1}: pixelDirettriceId mancante o invalido`);
    }
    if (!positiveId(pix.pixelVersione)) {
      fail(`missione ${i + 1}: pixelVersione mancante o invalida`);
    }
    if (typeof pix.corridoioPixelId !== 'string' || !pix.corridoioPixelId.trim()) {
      fail(`missione ${i + 1}: corridoioPixelId/engine ID mancante`);
    }
    // Se l'assembler già espone identità PIXEL, non sovrascriverle silenziosamente.
    for (const [campo, valore] of [
      ['pixelOpportunitaId', Number(pix.pixelOpportunitaId)],
      ['pixelDirettriceId', Number(pix.pixelDirettriceId)],
      ['pixelVersione', Number(pix.pixelVersione)],
      ['corridoioPixelId', pix.corridoioPixelId]
    ]) {
      if (m[campo] != null && m[campo] !== valore) {
        fail(`missione ${i + 1}: ${campo} discordante`);
      }
    }
    if (m.nodiTerritoriali != null &&
        (!Array.isArray(m.nodiTerritoriali) ||
         m.nodiTerritoriali.length !== pix.nodiTerritoriali.length ||
         m.nodiTerritoriali.some((id, j) => Number(id) !== Number(pix.nodiTerritoriali[j])))) {
      fail(`missione ${i + 1}: nodiTerritoriali discordanti`);
    }
    if ((m.schemaVersion != null && Number(m.schemaVersion) !== 2) ||
        (m.tipoItinerario != null && m.tipoItinerario !== 'FERMATE_FISICHE')) {
      fail(`missione ${i + 1}: marker V2 discordanti`);
    }
    return {
      ...m,
      schemaVersion: 2,
      tipoItinerario: 'FERMATE_FISICHE',
      pixelOpportunitaId: Number(pix.pixelOpportunitaId),
      pixelDirettriceId: Number(pix.pixelDirettriceId),
      pixelVersione: Number(pix.pixelVersione),
      corridoioPixelId: pix.corridoioPixelId,
      nodiTerritoriali: pix.nodiTerritoriali.map(Number)
    };
  }) : plan.missioni;
  const pianoValidabile = v2 ? { ...plan, missioni: missioniComplete } : plan;

  validaPianoMultiMissione(pianoValidabile, { veicoloId, postiTotali });
  if (!Array.isArray(richiesteBloccate) ||
      richiesteBloccate.length !== pianoValidabile.evaluation.requests.length) {
    fail('richieste DB incomplete');
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
  const occupazione = validaOccupazioneMultiMissione(pianoValidabile, richiesteBloccate, postiTotali);
  if (pianoValidabile.evaluation.peak != null &&
      Number(pianoValidabile.evaluation.peak) !== occupazione.peak) {
    fail('picco assembler diverso dal DB');
  }
  const snapshot = [];
  for (const ref of pianoValidabile.evaluation.requests) {
    const r = byId.get(Number(ref.id));
    if (!r) fail(`richiesta ${ref.id} assente`);
    const expected = Number(pianoValidabile.evaluation.departure) +
      Number(pianoValidabile.evaluation.times[ref.start]);
    if (Math.abs(asMs(r.start_datetime) - expected) > 1800000) {
      fail(`orario richiesta ${ref.id} fuori tolleranza`);
    }
    const fp = fingerprintRichiesta(r);
    if (typeof fp !== 'string' || !fp.length) fail(`fingerprint ${ref.id} non valido`);
    snapshot.push({ id: Number(ref.id), fingerprint: fp });
  }

  const missioniPersistibili = pianoValidabile.missioni.map((m, i) => {
    const pix = opportunitaMissioni[i];
    if (!positiveId(pix?.pixelOpportunitaId)) fail(`opportunita PIXEL missione ${i + 1} assente`);
    const s = Number(m.startIndex), e = Number(m.endIndex);
    const requests = pianoValidabile.evaluation.requests
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
        pixelDirettriceId: m.pixelDirettriceId,
        pixelVersione: m.pixelVersione,
        nodiTerritoriali: [...m.nodiTerritoriali]
      } : {}),
      nodes: pianoValidabile.nodes.slice(s, e + 1),
      legs: pianoValidabile.legs.slice(s, e),
      departure: Number(m.partenza),
      arrival: Number(m.arrivo),
      requests
    };
  });
  const piano = {
    ...pianoValidabile,
    evaluation: { ...pianoValidabile.evaluation, peak: occupazione.peak },
    requestSnapshot: snapshot,
    attivabile: false
  };
  return { piano, missioniPersistibili };
}
