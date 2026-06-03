import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita, filterSlotOnly } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDisponibilitaBatch } from './disponibilita/disponibilita.service.js'; 

const GEOHASH_PRECISION_TRATTA = 5;

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Ricerca | Tipo: ${richiesta.tipo_richiesto} | Posti: ${richiesta.posti_richiesti}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const pStart = turf.point([lon, lat]);
  const targetDate = new Date(richiesta.start_datetime || Date.now());
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);

  // 1. RECUPERO CORSE (Redis + Local Cache)
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  const results = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));
  const candidateIds = [...new Set(results.flat())];
  const corseCandidate = candidateIds.map(id => CacheStore.corseCache.get(Number(id))).filter(Boolean);

  let prenotazioniBatch = [];
  if (corseCandidate.length > 0) {
    const pipeline = redisClient.multi();
    corseCandidate.forEach(c => pipeline.hVals(`corsa:prenotazioni:${c.id}`));
    prenotazioniBatch = await pipeline.exec();
  }

  const { corse: corseEsistenti } = await filterDisponibilita(
    { ...richiesta, posti_richiesti: postiRichiesti, coord: { lat, lon } },
    corseCandidate,
    prenotazioniBatch
  );

  const risultatiCondivise = corseEsistenti.map(c => ({ 
    ...c, 
    tipo: 'condivisa', 
    tipo_corsa: 'condivisa', 
    is_slot: false 
  }));

  // 2. FILTRO ESCLUSIVITÀ RIEMPIMENTO
  const esisteRiempimentoEsistente = risultatiCondivise.some(c => 
    c.tipo_corsa === 'riempimento' && c.stato === 'da_attivare' &&
    c.path_geohashes?.some(h => hashes.includes(h))
  );

  // 3. RECUPERO SLOT (Batching ottimizzato)
  const TOLLERANZA_SLOT_KM = 50;
  const veicoliImpegnati = new Set(risultatiCondivise.map(c => c.veicolo_id));
  
  const candidatiSlot = Array.from(CacheStore.disponibilitaCache.values()).filter(s => {
    const v = CacheStore.veicoliCache.get(Number(s.veicolo_id));
    return v?.lat && v?.lon && !veicoliImpegnati.has(s.veicolo_id);
  });

  const driverIds = [...new Set(candidatiSlot.map(s => s.driver_id))];
  const disponibilitàMap = await getDisponibilitaBatch(driverIds, targetDate);

  const allSlots = candidatiSlot.map(s => {
    const v = CacheStore.veicoliCache.get(Number(s.veicolo_id));
    const dist = turf.distance(pStart, turf.point([v.lon, v.lat]), { units: 'kilometers' });
    if (dist > TOLLERANZA_SLOT_KM) return null;

    const disponibilitàDriver = disponibilitàMap.get(s.driver_id) || [];
    return { 
      ...s, 
      disponibile: disponibilitàDriver.some(st => st.disponibile), 
      posti_totali: Number(v.posti_totali || 0) 
    };
  });

  const slotsValidi = filterSlotOnly({ posti_richiesti: postiRichiesti }, allSlots.filter(Boolean));

  // 4. ASSEMBLAGGIO FINALE
  // Qui forziamo il tipo_corsa in base alla logica di ricerca, così il formatter lo legge correttamente
  const slotsFormattati = slotsValidi.map(s => {
    let tipo = 'privata';
    if (richiesta.tipo_richiesto !== 'privata' && !esisteRiempimentoEsistente) {
      tipo = 'riempimento';
    }
    return { ...s, tipo: tipo, tipo_corsa: tipo, is_slot: true };
  });

  const risultatiFinali = [...risultatiCondivise, ...slotsFormattati];

  return risultatiFinali.length > 0 
    ? await formatResults(richiesta, risultatiFinali, risultatiCondivise, CacheStore.veicoliCache)
    : [];
}