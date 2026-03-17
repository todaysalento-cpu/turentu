import { loadCachesUltra, veicoliCache, disponibilitaCache, corseCache } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';

export async function cercaSlotUltra(richiesta) {
  await loadCachesUltra();

  if (!veicoliCache || !disponibilitaCache || !corseCache) {
    throw new Error('Cache non caricata correttamente');
  }

  const { slots, corse } = filterDisponibilita(
    richiesta,
    veicoliCache,
    disponibilitaCache,
    corseCache
  );

  return formatResults(richiesta, slots, corse, veicoliCache);
}
