import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDisponibilitaBatch } from './disponibilita/disponibilita.service.js'; 

const GEOHASH_PRECISION_TRATTA = 5;

const getSafeDate = (val) => {
    const d = new Date(val);
    return isNaN(d.getTime()) ? new Date() : d;
};

/**
 * Normalizza le coordinate: garantisce [Lon, Lat]
 */
const normalizeCoords = (coords) => {
    if (!Array.isArray(coords) || coords.length === 0) return coords;
    // Se è un array di array (polilinea) e il primo elemento sembra [Lat, Lon] (es. > 20)
    if (Array.isArray(coords[0]) && Math.abs(coords[0][0]) > 20) {
        return coords.map(c => [c[1], c[0]]);
    }
    return coords;
};

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Ricerca | Lat: ${richiesta.coord?.lat} Lon: ${richiesta.coord?.lon}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const targetDate = getSafeDate(richiesta.start_datetime || Date.now());
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);

  // 1. RECUPERO GEOSPAZIALE
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  
  const [corsaResults, slotResults] = await Promise.all([
    Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`))),
    Promise.all(hashes.map(h => redisClient.sMembers(`slot:in_area:${h}`)))
  ]);

  // Recupero e Normalizzazione Geometria
  const corseCandidate = [...new Set(corsaResults.flat())].map(id => {
      const c = CacheStore.corseCache.get(Number(id));
      if (!c) return null;
      // Applichiamo la normalizzazione protettiva
      c.decodedCoords = normalizeCoords(c.decodedCoords);
      return c;
  }).filter(Boolean);

  const slotCandidateIds = [...new Set(slotResults.flat())].map(Number);
  const candidatiPool = slotCandidateIds.map(id => CacheStore.veicoloToDisponibilita.get(id)).filter(Boolean);

  // 2. FILTRO CORSE (Motore Geometrico/Saturazione)
  const impegniForti = corseCandidate.filter(c => c.tipo_corsa !== 'pop-bus' && c.stato === 'prenotabile');
  const prenotazioniBatch = corseCandidate.length > 0 ? await Promise.all(corseCandidate.map(c => redisClient.hVals(`corsa:prenotazioni:${c.id}`))) : [];

  const { corse: corseEsistenti } = await filterDisponibilita(
    { ...richiesta, posti_richiesti: postiRichiesti, coord: { lat, lon } },
    corseCandidate,
    prenotazioniBatch
  );

  const risultatiCondivise = corseEsistenti.map(c => ({ ...c, tipo: 'condivisa', is_slot: false }));

  // 3. LOGICA POOL (Pop Bus)
  const veicoliImpegnati = new Set(impegniForti.map(c => c.veicolo_id));
  const disponibilitàMap = await getDisponibilitaBatch(slotCandidateIds, targetDate, impegniForti);

  let risultatiPool = [];
  if (richiesta.tipo_richiesto === 'pop-bus') {
      const veicoliDisponibiliNelPool = candidatiPool.filter(s => {
          if (veicoliImpegnati.has(s.veicolo_id)) return false;
          
          const dispVeicolo = disponibilitàMap.get(s.veicolo_id) || [];
          return dispVeicolo.some(st => st.disponibile);
      });

      const capacitaTotale = veicoliDisponibiliNelPool.reduce((sum, s) => {
          const v = CacheStore.veicoliCache.get(Number(s.veicolo_id));
          return sum + Number(v?.posti_totali || 0);
      }, 0);

      if (capacitaTotale >= postiRichiesti) {
          risultatiPool.push({
              tipo: 'pop-bus', tipo_corsa: 'pop-bus', posti_totali: capacitaTotale,
              disponibile: true, is_slot: true, is_pool: true
          });
      }
  }

  // 4. ASSEMBLEA
  const risultatiFinali = [...risultatiCondivise, ...risultatiPool];
  console.log(`🏁 [FINALE] Risultati trovati: ${risultatiFinali.length}`);

  return risultatiFinali.length > 0 
    ? await formatResults(richiesta, risultatiFinali, risultatiCondivise)
    : [];
}