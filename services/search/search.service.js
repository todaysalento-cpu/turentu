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
  console.log(`📍 [REDIS] Ricerca in Geohash:`, hashes);
  
  const [corsaResults, slotResults] = await Promise.all([
    Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`))),
    Promise.all(hashes.map(h => redisClient.sMembers(`slot:in_area:${h}`)))
  ]);

  // LOG: Verifica cosa torna da Redis
  hashes.forEach((h, i) => {
      console.log(`   Hash ${h} -> Corse: ${corsaResults[i].length}, Slot: ${slotResults[i].length}`);
  });

  const corseCandidate = [...new Set(corsaResults.flat())].map(id => CacheStore.corseCache.get(Number(id))).filter(Boolean);
  const slotCandidateIds = [...new Set(slotResults.flat())].map(Number);
  
  console.log(`   Totale ID Slot unici trovati: ${slotCandidateIds.length}`);
  const candidatiPool = slotCandidateIds.map(id => CacheStore.veicoloToDisponibilita.get(id)).filter(Boolean);
  console.log(`   Oggetti Slot validi nel CacheStore: ${candidatiPool.length}`);

  // 2. FILTRO CORSE
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
          if (veicoliImpegnati.has(s.veicolo_id)) {
              console.log(`   [POOL] Veicolo ${s.veicolo_id} scartato: Impegnato in corsa forte.`);
              return false;
          }
          
          const dispVeicolo = disponibilitàMap.get(s.veicolo_id) || [];
          const isDisp = dispVeicolo.some(st => st.disponibile);
          if (!isDisp) console.log(`   [POOL] Veicolo ${s.veicolo_id} scartato: Turno non disponibile.`);
          return isDisp;
      });

      console.log(`   [POOL] Veicoli disponibili dopo filtri: ${veicoliDisponibiliNelPool.length}`);

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