// ======================= services/search/search.service.js =======================
import { loadCachesUltra, getVeicoliCache, getDisponibilitaCache, getCorseCache } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';

/**
 * Cerca slot e corse disponibili in base alla richiesta del cliente
 * @param {Object} richiesta - dati della richiesta { coordOrig, coordDest, posti_richiesti, tipo_corsa, ecc. }
 * @returns {Array} risultati formattati per frontend
 */
export async function cercaSlotUltra(richiesta) {
  // Assicura che la cache sia caricata in Redis
  await loadCachesUltra();

  // Leggi le cache da Redis (getter ora asincroni)
  const veicoliCache = await getVeicoliCache();
  const disponibilitaCache = await getDisponibilitaCache();
  const corseCache = await getCorseCache();

  if (!veicoliCache || !disponibilitaCache || !corseCache) {
    throw new Error('Cache non caricata correttamente');
  }

  // Filtra slot e corse compatibili usando l'engine
  const { slots, corse } = filterDisponibilita(
    richiesta,
    veicoliCache,
    disponibilitaCache,
    corseCache
  );

  // Se non ci sono risultati, ritorna array vuoto
  if ((!slots || slots.length === 0) && (!corse || corse.length === 0)) {
    return [];
  }

  // Genera i risultati formattati per il frontend
  const risultati = formatResults(richiesta, slots, corse, veicoliCache);

  return risultati;
}

/**
 * Funzione helper: cerca slot per cliente specifico (può essere estensione futura)
 */
export async function cercaSlotPerCliente(clienteId, richiesta) {
  const risultati = await cercaSlotUltra(richiesta);
  // eventualmente filtra per clienteId se serve logica personalizzata
  return risultati;
}

/**
 * Funzione helper: cerca slot per autista / veicolo specifico
 */
export async function cercaSlotPerAutista(veicoloId) {
  await loadCachesUltra();
  const corseCache = await getCorseCache();
  if (!corseCache) return [];
  return corseCache.filter(c => c.veicolo_id === veicoloId);
}