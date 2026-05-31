import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';
import * as CacheModule from '../search.cache.js';
import { redisClient } from '../../../redis.js';
import ngeohash from 'ngeohash';

/**
 * Calcola l'orario e la distanza usando gli indici ZSET di Redis
 */
async function getDettagliTrattaRedis(corsaId, startCoord, endCoord) {
    const hStart = ngeohash.encode(startCoord.lat, startCoord.lon, 7);
    const hEnd = ngeohash.encode(endCoord.lat, endCoord.lon, 7);
    
    // Recupera indici dal ZSET (O(1))
    const idxStart = await redisClient.zScore(`corsa:percorso_hash:${corsaId}`, hStart);
    const idxEnd = await redisClient.zScore(`corsa:percorso_hash:${corsaId}`, hEnd);
    
    return { idxStart, idxEnd };
}

async function formatResultsAsSlots(richiesta, slotsFiltrati, corseFiltrate, injectedVeicoliMap = null) {
  const allItems = [...corseFiltrate.slice(0, 5), ...slotsFiltrati.slice(0, 5)].slice(0, CacheModule.TOP_RESULTS || 10);
  const veicoliMap = injectedVeicoliMap || CacheModule.CacheStore.veicoliCache;
  
  return await Promise.all(
    allItems.map(async (item) => {
      const isCorsa = !!item.start_datetime;
      const veicoloId = Number(item.veicolo_id);
      const v = veicoliMap.get(veicoloId);
      
      let oraPartenza = new Date(item.start_datetime || Date.now());
      let oraArrivo = new Date(oraPartenza.getTime() + (item.durata_ms || 0));
      let distanzaSegmentoKm = Number(item.distanza || 0);

      // --- LOGICA DINAMICA BASATA SU ZSET ---
      if (isCorsa && item.decodedCoords?.length > 0) {
        try {
          const { idxStart, idxEnd } = await getDettagliTrattaRedis(item.id, richiesta.coord, richiesta.coordDest);
          
          if (idxStart !== null && idxEnd !== null) {
            const totalPoints = item.decodedCoords.length;
            const ratioPartenza = idxStart / totalPoints;
            const ratioSegmento = (idxEnd - idxStart) / totalPoints;
            
            const durataTotaleMs = item.durata_ms || 0; // Assicurati di aver normalizzato questo campo
            
            oraPartenza = new Date(new Date(item.start_datetime).getTime() + (durataTotaleMs * ratioPartenza));
            oraArrivo = new Date(oraPartenza.getTime() + (durataTotaleMs * ratioSegmento));
            distanzaSegmentoKm = Number(item.distanza) * ratioSegmento;
          }
        } catch (e) {
          console.error(`[FORMAT ERROR] Errore calcolo ZSET per corsa ${item.id}:`, e);
        }
      }

      // --- CALCOLO PREZZO ---
      let prezzo = 0;
      try {
        prezzo = await calcolaPrezzo(item, richiesta.posti_richiesti, item.stato, distanzaSegmentoKm, Number(item.distanza));
      } catch (err) { prezzo = 0; }

      return {
        id: item.id || uuidv4(),
        veicolo_id: veicoloId,
        marca: v?.marca ?? null,
        modello: v?.modello ?? null,
        localitaOrigine: await getLocalitaSafe(richiesta.coord),
        localitaDestinazione: await getLocalitaSafe(richiesta.coordDest),
        oraPartenza: oraPartenza.toISOString(),
        oraArrivo: oraArrivo.toISOString(),
        distanzaKm: Number(distanzaSegmentoKm.toFixed(2)),
        prezzo: Number(prezzo?.toFixed(2)) || 0,
        stato: item.stato,
        postiDisponibili: Number(item.postiDisponibili ?? 0),
        // percorsoVisualizzato ora può essere recuperato con logica semplificata
        percorsoVisualizzato: isCorsa ? item.decodedCoords : null 
      };
    })
  );
}

export { formatResultsAsSlots as formatResults };