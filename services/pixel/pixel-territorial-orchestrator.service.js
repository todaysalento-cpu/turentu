// Destinazione: services/pixel/pixel-territorial-orchestrator.service.js
// Orchestratore territoriale PIXEL, avvio esplicito. Nessun cron, nessun POPBUS.
// Le informazioni Google Places sono usate solo in memoria e non vengono persistite.
import { discoverPixelComuneCandidates } from './pixel-stop-selection-comune.service.js';
import { registerPixelStopCandidate } from './pixel-stop-registration.service.js';

function codiceValido(codice) {
  if (!/^\d{6}$/.test(String(codice))) throw new Error('Codice ISTAT comunale non valido');
  return String(codice);
}

// PREVIEW: interroga Google Places e restituisce SOLTANTO metriche aggregate.
// Non restituisce nomi, coordinate, indirizzi o place_id a log/chiamanti.
export async function diagnosticaFermateComunePixel(codiceIstat, options = {}) {
  const codice = codiceValido(codiceIstat);
  const result = await discoverPixelComuneCandidates(codice, options);
  return {
    comune: codice,
    nodi: result.nodi ?? 0,
    limite: result.limite,
    censite: result.censite,
    residue: result.residue,
    candidati_locali_sommati: result.candidati_locali_sommati ?? 0,
    candidati_distinti: result.candidati_distinti ?? 0,
    selezionati_comunali: result.selezionati.length,
    copertura_nodi: result.copertura_nodi,
    stato: result.stato,
    errori: result.errori,
    scritture: 0,
    nota: 'Solo diagnostica. Nessun dettaglio Google Places salvato o restituito.'
  };
}

// REGISTRAZIONE: dati ottenuti INDIPENDENTEMENTE da Google, con attestazioni esplicite.
// Non richiama discovery e non trasforma candidati Google in fermate persistenti.
// Il servizio sottostante serializza per comune e inserisce attiva=false, verificata=false.
export async function registraFermataTerritorialePixel(dati) {
  if (!dati || typeof dati !== 'object' || Array.isArray(dati)) {
    throw new Error('Dati fermata mancanti');
  }
  return registerPixelStopCandidate(dati);
}
