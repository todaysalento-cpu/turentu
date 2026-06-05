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

const normalizeCoords = (coords) => {
    if (!Array.isArray(coords) || coords.length === 0) return coords;
    if (Array.isArray(coords[0]) && Math.abs(coords[0][0]) > 20) {
        return coords.map(c => [c[1], c[0]]);
    }
    return coords;
};

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Ricerca Universale | Lat: ${richiesta.coord?.lat} Lon: ${richiesta.coord?.lon}`);
  
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

  const corseCandidate = [...new Set(corsaResults.flat())].map(id => {
      const c = CacheStore.corseCache.get(Number(id));
      if (!c) return null;
      c.decodedCoords = normalizeCoords(c.decodedCoords);
      return c;
  }).filter(Boolean);

  const slotCandidateIds = [...new Set(slotResults.flat())].map(Number);
  const candidatiPool = slotCandidateIds.map(id => CacheStore.veicoloToDisponibilita.get(id)).filter(Boolean);

  // 2. FILTRO CORSE (Condivise su rotta esistente)
  const impegniForti = corseCandidate.filter(c => c.tipo_corsa !== 'pop-bus' && c.stato === 'prenotabile');
  const prenotazioniBatch = corseCandidate.length > 0 ? await Promise.all(corseCandidate.map(c => redisClient.hVals(`corsa:prenotazioni:${c.id}`))) : [];

  const { corse: corseEsistenti } = await filterDisponibilita(
    { ...richiesta, posti_richiesti: postiRichiesti, coord: { lat, lon } },
    corseCandidate,
    prenotazioniBatch
  );

  const risultatiCondivise = corseEsistenti.map(c => ({ ...c, tipo: 'condivisa', is_slot: false }));

  // 3. LOGICA AGGREGATA: SLOT PRIVATI E POP-BUS (On-demand)
  const veicoliImpegnati = new Set(impegniForti.map(c => c.veicolo_id));
  const disponibilitàMap = await getDisponibilitaBatch(slotCandidateIds, targetDate, impegniForti);

  let risultatiPool = [];
  let risultatiSlotPrivati = [];

  // Mappa di tutti i veicoli pronti nel geohash
  candidatiPool.forEach(s => {
      const dispVeicolo = disponibilitàMap.get(s.veicolo_id) || [];
      const isDisp = dispVeicolo.some(st => st.disponibile);
      const v = CacheStore.veicoliCache.get(Number(s.veicolo_id));

      if (isDisp && v) {
          // Aggiunta agli slot privati
          if (!veicoliImpegnati.has(s.veicolo_id)) {
              risultatiSlotPrivati.push({
                  tipo: 'privata_slot',
                  veicolo_id: s.veicolo_id,
                  marca: v.marca || 'N/D',
                  modello: v.modello || 'N/D',
                  rating: Number(v.rating || 0),
                  servizi: v.servizi || {},
                  posti_totali: v.posti_totali,
                  disponibile: true,
                  is_slot: true,
                  is_pool: false,
                  messaggio: "Acquista corsa privata dedicata"
              });
          }
      }
  });

  // Generazione dinamica Pop-Bus (indipendente dalle corse di linea)
  const veicoliDisponibiliPerPool = candidatiPool.filter(s => 
      !veicoliImpegnati.has(s.veicolo_id) && 
      (disponibilitàMap.get(s.veicolo_id) || []).some(st => st.disponibile)
  );

  const capacitaTotale = veicoliDisponibiliPerPool.reduce((sum, s) => {
      const v = CacheStore.veicoliCache.get(Number(s.veicolo_id));
      return sum + Number(v?.posti_totali || 0);
  }, 0);

  if (capacitaTotale >= postiRichiesti) {
      risultatiPool.push({
          tipo: 'pop-bus',
          tipo_corsa: 'pop-bus',
          posti_totali: capacitaTotale,
          veicoli_pool_ids: veicoliDisponibiliPerPool.map(s => Number(s.veicolo_id)),
          disponibile: true,
          is_slot: true,
          is_pool: true,
          messaggio: "Pop Bus: Servizio condiviso disponibile per questa tratta"
      });
  }

  // 4. ASSEMBLAGGIO FINALE
  const risultatiFinali = [...risultatiCondivise, ...risultatiSlotPrivati, ...risultatiPool];
  
  let distanzaMetri = 10000;
  if (richiesta.coord && richiesta.coordDest) {
      const from = turf.point([lon, lat]);
      const to = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
      distanzaMetri = turf.distance(from, to, { units: 'meters' });
  }

  const context = {
    ...richiesta,
    distanzaMetri: distanzaMetri,
    localitaOrigine: richiesta.localitaOrigine?.description || richiesta.localitaOrigine || "Partenza",
    localitaDestinazione: richiesta.localitaDestinazione?.description || richiesta.localitaDestinazione || "Destinazione"
  };
  
  console.log(`🏁 [FINALE] Risultati: ${risultatiFinali.length} | Distanza Calcolata: ${(distanzaMetri/1000).toFixed(2)} km`);

  return risultatiFinali.length > 0 
    ? await formatResults(context, risultatiFinali, risultatiCondivise)
    : [];
}