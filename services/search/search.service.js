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

  // 1. Recupero candidati con LOG approfondito
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  console.log(`[DEBUG GEOSH] Punto: ${lat},${lon} | Hash ricercato: ${hash} | Area vicini: ${hashes.length}`);
  
  // CORRETTO: Chiave uniformata in 'corsa:in_area:${h}'
  const results = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));
  const candidateIds = [...new Set(results.flat())];
  console.log(`[DEBUG GEOSH] Candidati trovati in Redis (ID):`, candidateIds);
  
  const corseCandidate = candidateIds
    .map(id => CacheStore.corseCache.get(Number(id)))
    .filter(Boolean);

  console.log(`[DEBUG SERVICE] Corse estratte dalla Cache: ${corseCandidate.length}`);

  if (corseCandidate.length === 0) {
    console.log(`[DEBUG SERVICE] Nessun candidato trovato per l'area.`);
    return [];
  }

  // 2. Recupero massivo prenotazioni
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

  // 3. Filtro avanzato con LOG per scartare i candidati
  console.log(`[DEBUG SERVICE] Avvio filtro disponibilità per ${corseCandidate.length} candidati.`);
  const { slots, corse: corseCompatibili } = await filterDisponibilita(
    richiestaNormalizzata,
    corseCandidate,
    prenotazioniBatch
  );

  if (!slots?.length) {
    console.log(`[DEBUG SERVICE] Filtro completato: 0 slot compatibili trovati.`);
    return [];
  }

  console.log(`[DEBUG SERVICE] Filtro completato: ${slots.length} slot trovati.`);

  // 4. Formattazione finale
  try {
    const risultati = await formatResults(
      richiestaNormalizzata, 
      slots, 
      corseCompatibili, 
      CacheStore.veicoliCache 
    );
    
    console.log(`[DEBUG SERVICE] Risultati finali formattati: ${risultati?.length || 0}`);
    return Array.isArray(risultati) ? risultati : [];
  } catch (err) {
    console.error("💥 [SERVICE] Errore critico in formatResults:", err);
    return []; 
  }
}