import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
// Assicurati che il percorso di import sia corretto
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita, filterSlotOnly } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDisponibilita } from './disponibilita/disponibilita.service.js';

const GEOHASH_PRECISION_TRATTA = 5;

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Inizio ricerca dinamica | Posti: ${richiesta.posti_richiesti}`);
  
  // 0. Caricamento cache (assicurati che sia esportata in search.cache.js)
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const pStart = turf.point([lon, lat]);
  const targetDate = new Date(richiesta.start_datetime || Date.now());
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);

  // 1. Recupero corse candidato
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  const results = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));
  const candidateIds = [...new Set(results.flat())];
  const corseCandidate = candidateIds.map(id => CacheStore.corseCache.get(Number(id))).filter(Boolean);

  // 2. Recupero prenotazioni batch
  let prenotazioniBatch = [];
  if (corseCandidate.length > 0) {
    const pipeline = redisClient.multi();
    corseCandidate.forEach(c => pipeline.hVals(`corsa:prenotazioni:${c.id}`));
    prenotazioniBatch = await pipeline.exec();
  }

  // 3. ESECUZIONE FILTRI CORSE
  const { corse: corseValide } = await filterDisponibilita(
    { ...richiesta, posti_richiesti: postiRichiesti, coord: { lat, lon } },
    corseCandidate,
    prenotazioniBatch
  );

  // 4. Gestione Slot Generici (CORRETTO IL NOME CacheStore.veicoliCache)
  const TOLLERANZA_SLOT_KM = 50; 
  const allSlots = await Promise.all(
    Array.from(CacheStore.disponibilitaCache.values()).map(async (s) => {
      const veicolo = CacheStore.veicoliCache.get(Number(s.veicolo_id));
      if (!veicolo?.lat || !veicolo?.lon) return null;

      const dist = turf.distance(pStart, turf.point([veicolo.lon, veicolo.lat]), { units: 'kilometers' });
      if (dist > TOLLERANZA_SLOT_KM) return null;

      const stati = await getDisponibilita(s.driver_id, targetDate);
      return {
        ...s,
        disponibile: stati.some(st => st.disponibile),
        posti_totali: veicolo ? Number(veicolo.posti_totali || 0) : 0
      };
    })
  );
  
  const slotsLiberi = filterSlotOnly({ posti_richiesti: postiRichiesti }, allSlots.filter(Boolean));

  // 5. SEPARAZIONE E FUSIONE
  const risultatiCorse = corseValide.map(c => ({ ...c, is_slot: false }));
  const risultatiSlot = slotsLiberi.filter(s => 
    !risultatiCorse.some(c => c.veicolo_id === s.veicolo_id)
  ).map(s => ({ ...s, is_slot: true }));

  const risultatiFinali = [...risultatiCorse, ...risultatiSlot];
  
  if (risultatiFinali.length === 0) return [];

  // 6. Formattazione finale
  try {
    return await formatResults(richiesta, risultatiFinali, corseValide, CacheStore.veicoliCache);
  } catch (err) {
    console.error("💥 [SERVICE] Errore in formatResults:", err);
    return []; 
  }
}