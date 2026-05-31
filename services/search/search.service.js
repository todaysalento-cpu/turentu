import { loadCachesUltra, CacheStore } from './search.cache.js';
import { filterDisponibilita, filterSlotOnly } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { redisClient } from '../../redis.js';
import ngeohash from 'ngeohash';

const GEOHASH_PRECISION_TRATTA = 5;

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Inizio ricerca dinamica | Posti: ${richiesta.posti_richiesti}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);

  // 1. Recupero candidati (Corse)
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  const results = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));
  const candidateIds = [...new Set(results.flat())];
  
  const corseCandidate = candidateIds
    .map(id => CacheStore.corseCache.get(Number(id)))
    .filter(Boolean);

  // 2. Recupero massivo prenotazioni per le corse trovate
  let prenotazioniBatch = [];
  if (corseCandidate.length > 0) {
    const pipeline = redisClient.multi();
    corseCandidate.forEach(c => pipeline.hVals(`corsa:prenotazioni:${c.id}`));
    prenotazioniBatch = await pipeline.exec();
  }

  const richiestaNormalizzata = {
    ...richiesta,
    posti_richiesti: Number(richiesta.posti_richiesti),
    coord: { lat, lon },
    lat,
    lon
  };

  // 3. ESECUZIONE FILTRI (Duale: Corse + Slot Generici)
  
  // A. Filtro Corse (Geometrico/Turf)
  const { slots: slotsCorse, corse: corseCompatibili } = await filterDisponibilita(
    richiestaNormalizzata,
    corseCandidate,
    prenotazioniBatch
  );

  // B. Filtro Slot Generici (Disponibilità pura, senza vincoli di rotta)
  const allSlots = Array.from(CacheStore.disponibilitaCache.values());
  const slotsLiberi = await filterSlotOnly(richiestaNormalizzata, allSlots);

  // 4. FUSIONE DEI RISULTATI (Deduplicazione su veicolo_id)
  const mapRisultati = new Map();
  
  // Aggiungiamo prima gli slot liberi
  slotsLiberi.forEach(s => mapRisultati.set(s.veicolo_id, s));
  // Sovrascriviamo con le corse specifiche (priorità alla rotta definita)
  slotsCorse.forEach(s => mapRisultati.set(s.veicolo_id, s));

  const risultatiFinali = Array.from(mapRisultati.values());

  console.log(`[SERVICE] Filtro completato: ${risultatiFinali.length} slot trovati (Corse: ${slotsCorse.length}, Generici: ${slotsLiberi.length})`);

  if (risultatiFinali.length === 0) return [];

  // 5. Formattazione finale
  try {
    const risultati = await formatResults(
      richiestaNormalizzata, 
      risultatiFinali, 
      corseCompatibili, 
      CacheStore.veicoliCache 
    );
    
    return Array.isArray(risultati) ? risultati : [];
  } catch (err) {
    console.error("💥 [SERVICE] Errore critico in formatResults:", err);
    return []; 
  }
}