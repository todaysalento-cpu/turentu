import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita, filterSlotOnly } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDisponibilitaBatch } from './disponibilita/disponibilita.service.js'; 

const GEOHASH_PRECISION_TRATTA = 5;

/**
 * Utility locale per validare date prima di usarle
 */
const getSafeDate = (val) => {
    const d = new Date(val);
    return isNaN(d.getTime()) ? new Date() : d;
};

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Ricerca | Tipo: ${richiesta.tipo_richiesto} | Posti: ${richiesta.posti_richiesti}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const pStart = turf.point([lon, lat]);
  
  // Protezione data richiesta
  const targetDate = getSafeDate(richiesta.start_datetime || Date.now());
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);

  // 1. RECUPERO CORSE
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

  // 3. RECUPERO SLOT (Batching con verifica driver_id)
  const TOLLERANZA_SLOT_KM = 50;
  const veicoliImpegnati = new Set(risultatiCondivise.map(c => c.veicolo_id));
  
  const candidatiSlot = Array.from(CacheStore.disponibilitaCache.values()).filter(s => {
    const v = CacheStore.veicoliCache.get(Number(s.veicolo_id));
    // Assicuriamo di filtrare solo veicoli esistenti e non impegnati
    return v?.lat && v?.lon && !veicoliImpegnati.has(s.veicolo_id);
  });

  // Filtriamo i driver_id eliminando i nulli per evitare errori nel batch
  const driverIds = [...new Set(candidatiSlot.map(s => s.driver_id).filter(Boolean))];
  const disponibilitàMap = await getDisponibilitaBatch(driverIds, targetDate);

  const allSlots = candidatiSlot.map(s => {
    const v = CacheStore.veicoliCache.get(Number(s.veicolo_id));
    const dist = turf.distance(pStart, turf.point([v.lon, v.lat]), { units: 'kilometers' });
    if (dist > TOLLERANZA_SLOT_KM) return null;

    // Recupero disponibilità basato sul driver_id
    const disponibilitàDriver = disponibilitàMap.get(s.driver_id) || [];
    return { 
      ...s, 
      disponibile: disponibilitàDriver.some(st => st.disponibile), 
      posti_totali: Number(v.posti_totali || 0),
      tipo_corsa: s.tipo_corsa || v.tipo_corsa || 'privata'
    };
  });

  const slotsValidi = filterSlotOnly({ posti_richiesti: postiRichiesti }, allSlots.filter(Boolean));

  // 4. ASSEMBLAGGIO FINALE
  const slotsFormattati = slotsValidi.map(s => {
    const tipo = s.tipo_corsa || (richiesta.tipo_richiesto === 'privata' ? 'privata' : 'riempimento');
    return { ...s, tipo: tipo, tipo_corsa: tipo, is_slot: true };
  });

  const risultatiFinali = [...risultatiCondivise, ...slotsFormattati].filter(item => {
    const posti = Number(item.posti_totali || item.postiTotali || 0);
    return posti > 0 && posti < 100;
  });

  return risultatiFinali.length > 0 
    ? await formatResults(richiesta, risultatiFinali, risultatiCondivise, CacheStore.veicoliCache)
    : [];
}