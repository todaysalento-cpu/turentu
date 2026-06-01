import { loadCachesUltra, CacheStore } from './search.cache.js';
import { filterDisponibilita, filterSlotOnly } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDisponibilita } from './disponibilita/disponibilita.service.js';
import { redisClient } from '../../redis.js';
import ngeohash from 'ngeohash';

const GEOHASH_PRECISION_TRATTA = 5;

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Inizio ricerca dinamica | Posti: ${richiesta.posti_richiesti}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const targetDate = new Date(richiesta.start_datetime || Date.now());
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);

  // 2. Recupero candidati (Corse)
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  const results = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));
  const candidateIds = [...new Set(results.flat())];
  
  const corseCandidate = candidateIds
    .map(id => CacheStore.corseCache.get(Number(id)))
    .filter(Boolean);

  // 3. Recupero massivo prenotazioni
  let prenotazioniBatch = [];
  if (corseCandidate.length > 0) {
    const pipeline = redisClient.multi();
    corseCandidate.forEach(c => pipeline.hVals(`corsa:prenotazioni:${c.id}`));
    prenotazioniBatch = await pipeline.exec();
  }

  const richiestaNormalizzata = {
    ...richiesta,
    posti_richiesti: postiRichiesti,
    coord: { lat, lon },
    lat,
    lon
  };

  // 4. ESECUZIONE FILTRI
  const { slots: slotsCorse, corse: corseCompatibili } = await filterDisponibilita(
    richiestaNormalizzata,
    corseCandidate,
    prenotazioniBatch
  );

  const allSlots = await Promise.all(
    Array.from(CacheStore.disponibilitaCache.values()).map(async (s) => {
      const stati = await getDisponibilita(s.driver_id, targetDate);
      const veicolo = CacheStore.veicoliCache.get(Number(s.veicolo_id));
      const postiReali = veicolo ? Number(veicolo.posti_totali || 0) : 0;
      
      return {
        ...s,
        disponibile: stati.some(st => st.disponibile),
        posti_totali: postiReali,
        start_datetime: targetDate.toISOString() 
      };
    })
  );
  
  const slotsLiberi = await filterSlotOnly(richiestaNormalizzata, allSlots);

  // 5. FUSIONE E PULIZIA DEI RISULTATI
  const mapRisultati = new Map();
  
  // Garantiamo array validi
  const arraySlotsLiberi = Array.isArray(slotsLiberi) ? slotsLiberi : [];
  const arraySlotsCorse = Array.isArray(slotsCorse) ? slotsCorse : [];

  // Filtriamo subito per posti disponibili prima di inserire in Map
  arraySlotsLiberi
    .filter(s => s.disponibile && s.posti_totali >= postiRichiesti)
    .forEach(s => mapRisultati.set(s.veicolo_id, s));

  arraySlotsCorse
    .filter(c => c.postiDisponibili >= postiRichiesti)
    .forEach(c => mapRisultati.set(c.veicolo_id, c));

  const risultatiFinali = Array.from(mapRisultati.values());

  console.log(`[SERVICE] Filtro completato: ${risultatiFinali.length} slot validi (Corse: ${arraySlotsCorse.length}, Generici: ${arraySlotsLiberi.length})`);

  if (risultatiFinali.length === 0) return [];

  // 6. Formattazione finale
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