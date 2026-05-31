import { loadCachesUltra, CacheStore } from './search.cache.js';
import { filterDisponibilita, filterSlotOnly } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDisponibilita } from './disponibilita/disponibilita.service.js'; // Import per calcolo dinamico
import { redisClient } from '../../redis.js';
import ngeohash from 'ngeohash';

const GEOHASH_PRECISION_TRATTA = 5;

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Inizio ricerca dinamica | Posti: ${richiesta.posti_richiesti}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const targetDate = new Date(richiesta.start_datetime || Date.now());

  // 1. Recupero candidati (Corse)
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  const results = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));
  const candidateIds = [...new Set(results.flat())];
  
  const corseCandidate = candidateIds
    .map(id => CacheStore.corseCache.get(Number(id)))
    .filter(Boolean);

  // 2. Recupero massivo prenotazioni
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

  // 3. ESECUZIONE FILTRI
  
  // A. Filtro Corse (Geometrico)
  const { slots: slotsCorse, corse: corseCompatibili } = await filterDisponibilita(
    richiestaNormalizzata,
    corseCandidate,
    prenotazioniBatch
  );

  // B. Filtro Slot Generici (Arricchimento dinamico con targetDate)
  const allSlots = await Promise.all(
    Array.from(CacheStore.disponibilitaCache.values()).map(async (s) => {
      const stati = await getDisponibilita(s.driver_id, targetDate);
      return {
        ...s,
        disponibile: stati.some(st => st.disponibile),
        posti_totali: Number(s.posti_totali || 0)
      };
    })
  );
  
  const slotsLiberi = await filterSlotOnly(richiestaNormalizzata, allSlots);

  // 4. FUSIONE DEI RISULTATI
  const mapRisultati = new Map();
  slotsLiberi.forEach(s => mapRisultati.set(s.veicolo_id, s));
  slotsCorse.forEach(s => mapRisultati.set(s.veicolo_id, s));

  const risultatiFinali = Array.from(mapRisultati.values());

  console.log(`[SERVICE] Filtro completato: ${risultatiFinali.length} slot trovati (Corse: ${slotsCorse.length}, Generici: ${slotsLiberi.length})`);

  if (risultatiFinali.length === 0) return [];

  // 5. Formattazione finale
  try {
    return await formatResults(
      richiestaNormalizzata, 
      risultatiFinali, 
      corseCompatibili, 
      CacheStore.veicoliCache 
    );
  } catch (err) {
    console.error("💥 [SERVICE] Errore critico in formatResults:", err);
    return []; 
  }
}