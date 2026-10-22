// services/pixel/pixel-stop-registration.service.js
// Registrazione SOLO di fermate censite indipendentemente e validate per l'inserimento.
// NON passare direttamente oggetti Google Places a questa funzione.
import { insertPixelStopCandidate } from './pixel-stop-budget.service.js';

const SOURCES = new Set(['rilievo_operatore', 'fonte_pubblica_riutilizzabile']);

export async function registerPixelStopCandidate({
  nodo_territoriale_id, nome, indirizzo = null, lat, lon,
  fonte, riferimento_fonte, autorizzazione_uso_dati = false,
  conferma_punto_salita = false,
}) {
  if (!SOURCES.has(fonte)) throw new Error('Fonte non ammessa: vietato registrare direttamente dati Google Places');
  if (!autorizzazione_uso_dati || typeof riferimento_fonte !== 'string' || !riferimento_fonte.trim()) {
    throw new Error('Servono diritti di riutilizzo e riferimento della fonte');
  }
  if (!conferma_punto_salita) throw new Error('Punto di salita non ancora confermato');
  // La funzione sottostante applica lock comunale, controllo duplicati e
  // inserisce SEMPRE verificata=false, attiva=false.
  return insertPixelStopCandidate({ nodo_territoriale_id, nome, indirizzo, lat, lon });
}
