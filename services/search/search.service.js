import { loadCachesUltra, CacheStore } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { redisClient } from '../../redis.js';
import ngeohash from 'ngeohash';

const GEOHASH_PRECISION_TRATTA = 5;

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Inizio ricerca dinamica | Posti: ${richiesta.posti_richiesti}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);

  // 1. Recupero candidati (incluso vicini)
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  
  const candidateIds = [...new Set(
    (await Promise.all(hashes.map(h => redisClient.sMembers(`corsa_in_area:${h}`)))).flat()
  )];
  
  const corseCandidate = candidateIds
    .map(id => CacheStore.corseCache.get(Number(id)))
    .filter(Boolean);

  if (corseCandidate.length === 0) return [];

  // 2. Recupero massivo prenotazioni in pipeline (Ottimizzazione Critica)
  const pipeline = redisClient.multi();
  corseCandidate.forEach(c => pipeline.hVals(`corsa:prenotazioni:${c.id}`));
  const prenotazioniBatch = await pipeline.exec();

  const richiestaNormalizzata = {
    ...richiesta,
    posti_richiesti: Number(richiesta.posti_richiesti),
    coord: { lat, lon },
    lat,
    lon
  };

  // 3. Filtro avanzato (passiamo i dati già pronti al motore)
  const { slots, corse: corseCompatibili } = await filterDisponibilita(
    richiestaNormalizzata,
    corseCandidate,
    prenotazioniBatch // Passiamo le prenotazioni caricate in pipeline
  );

  if (!slots?.length) return [];

  // 4. Formattazione finale
  try {
    const risultati = await formatResults(
      richiestaNormalizzata, 
      slots, 
      corseCompatibili, 
      CacheStore.veicoliCache 
    );
    
    return Array.isArray(risultati) ? risultati : [];
  } catch (err) {
    console.error("💥 [SERVICE] Errore critico:", err);
    return []; 
  }
}