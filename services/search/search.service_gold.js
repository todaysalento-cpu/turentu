// services/search/search.service.js
import { loadCachesUltra, getVeicoliCache, getDisponibilitaCache, getCorseCache } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';

export async function cercaSlotUltra(richiesta) {
  // Carica le cache se non sono già caricate
  await loadCachesUltra();

  // Usa i getter per leggere le cache
  const veicoliCache = getVeicoliCache();
  const disponibilitaCache = getDisponibilitaCache();
  const corseCache = getCorseCache();

  if (!veicoliCache || !disponibilitaCache || !corseCache) {
    throw new Error('Cache non caricata correttamente');
  }

  // Filtra slot e corse compatibili
  const { slots, corse } = filterDisponibilita(
    richiesta,
    veicoliCache,
    disponibilitaCache,
    corseCache
  );

  // Genera i risultati formattati per il frontend
  return formatResults(richiesta, slots, corse, veicoliCache);
}
