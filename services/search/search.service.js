import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita, filterSlotOnly } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDisponibilitaBatch } from './disponibilita/disponibilita.service.js'; 

const GEOHASH_PRECISION_TRATTA = 5;

const getSafeDate = (val) => {
    const d = new Date(val);
    return isNaN(d.getTime()) ? new Date() : d;
};

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Ricerca Domanda-Centrica | Tipo: ${richiesta.tipo_richiesto} | Posti: ${richiesta.posti_richiesti}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const pStart = turf.point([lon, lat]);
  const targetDate = getSafeDate(richiesta.start_datetime || Date.now());
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);

  // 1. RECUPERO CORSE ESISTENTI (PRIVATA/CONDIVISA)
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  const results = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));
  const corseCandidate = [...new Set(results.flat())].map(id => CacheStore.corseCache.get(Number(id))).filter(Boolean);

  const impegniForti = corseCandidate.filter(c => c.tipo_corsa !== 'pop-bus' && c.stato === 'prenotabile');
  const prenotazioniBatch = corseCandidate.length > 0 ? await Promise.all(corseCandidate.map(c => redisClient.hVals(`corsa:prenotazioni:${c.id}`))) : [];

  const { corse: corseEsistenti } = await filterDisponibilita(
    { ...richiesta, posti_richiesti: postiRichiesti, coord: { lat, lon } },
    corseCandidate,
    prenotazioniBatch
  );

  const risultatiCondivise = corseEsistenti.map(c => ({ ...c, tipo: 'condivisa', is_slot: false }));

  // 2. RECUPERO SLOT E AGGREGAZIONE POOL
  const veicoliImpegnati = new Set(impegniForti.map(c => c.veicolo_id));
  
  // Filtro veicoli candidati nel raggio geografico
  const candidatiPool = Array.from(CacheStore.disponibilitaCache.values()).filter(s => {
    const v = CacheStore.veicoliCache.get(Number(s.veicolo_id));
    if (!v?.lat || !v?.lon || veicoliImpegnati.has(s.veicolo_id)) return false;
    const dist = turf.distance(pStart, turf.point([v.lon, v.lat]), { units: 'kilometers' });
    return dist <= 50;
  });

  const driverIds = [...new Set(candidatiPool.map(s => s.driver_id).filter(Boolean))];
  const disponibilitàMap = await getDisponibilitaBatch(driverIds, targetDate, impegniForti);

  // 3. LOGICA DI POOL AGGREGATO (Pop Bus)
  // Identifichiamo i veicoli disponibili per la richiesta corrente
  const veicoliDisponibiliNelPool = candidatiPool.filter(s => {
      const dispDriver = disponibilitàMap.get(s.driver_id) || [];
      return dispDriver.some(st => st.disponibile);
  }).map(s => CacheStore.veicoliCache.get(Number(s.veicolo_id)));

  let risultatiPool = [];
  if (richiesta.tipo_richiesto === 'pop-bus') {
      const capacitaTotale = veicoliDisponibiliNelPool.reduce((sum, v) => sum + Number(v.posti_totali || 0), 0);
      if (capacitaTotale >= postiRichiesti) {
          risultatiPool.push({
              tipo: 'pop-bus',
              tipo_corsa: 'pop-bus',
              posti_totali: capacitaTotale,
              disponibile: true,
              is_slot: true,
              is_pool: true // Flag per il formatter per visualizzare il "Pool di offerta"
          });
      }
  }

  // 4. ASSEMBLAGGIO FINALE
  const risultatiFinali = [
    ...risultatiCondivise, 
    ...risultatiPool
  ].filter(item => item.posti_totali > 0 && item.posti_totali < 100);

  return risultatiFinali.length > 0 
    ? await formatResults(richiesta, risultatiFinali, risultatiCondivise, CacheStore.veicoliCache)
    : [];
}