import { v4 as uuidv4 } from 'uuid';
import { calcolaPrezzo } from '../../../utils/pricing.util.js';
import { getLocalitaSafe } from '../../../utils/maps.util.js';
import * as CacheModule from '../search.cache.js';
import { redisClient } from '../../../redis.js';
import ngeohash from 'ngeohash';

const MATCHING_PRECISION = 5;

async function getDettagliTrattaRedis(corsaId, startCoord, endCoord) {
    const hStart = ngeohash.encode(startCoord.lat, startCoord.lon, MATCHING_PRECISION);
    const hEnd = ngeohash.encode(endCoord.lat, endCoord.lon, MATCHING_PRECISION);
    
    const idxStart = await redisClient.zScore(`corsa:percorso_hash:${corsaId}`, hStart);
    const idxEnd = await redisClient.zScore(`corsa:percorso_hash:${corsaId}`, hEnd);
    
    return { 
        idxStart: idxStart !== null ? Number(idxStart) : null, 
        idxEnd: idxEnd !== null ? Number(idxEnd) : null 
    };
}

async function formatResultsAsSlots(richiesta, slotsFiltrati, corseFiltrate, injectedVeicoliMap = null) {
  const allItems = [...corseFiltrate.slice(0, 5), ...slotsFiltrati.slice(0, 5)].slice(0, CacheModule.TOP_RESULTS || 10);
  const veicoliMap = injectedVeicoliMap || CacheModule.CacheStore.veicoliCache;
  
  console.log(`🔍 [FORMATTER] Inizio formattazione di ${allItems.length} elementi.`);
  
  const results = await Promise.all(
    allItems.map(async (item) => {
      try {
        const isCorsa = !!item.start_datetime;
        const veicoloId = Number(item.veicolo_id);
        const v = veicoliMap.get(veicoloId);
        
        let oraPartenza = new Date(item.start_datetime || Date.now());
        let oraArrivo = new Date(oraPartenza.getTime() + (item.durata_ms || 0));
        let distanzaSegmentoKm = Number(item.distanza || 0);

        if (isCorsa && item.decodedCoords?.length > 0) {
          const { idxStart, idxEnd } = await getDettagliTrattaRedis(item.id, richiesta.coord, richiesta.coordDest);
          
          if (idxStart !== null && idxEnd !== null && idxEnd > idxStart) {
            const totalPoints = item.decodedCoords.length;
            const ratioPartenza = idxStart / totalPoints;
            const ratioSegmento = (idxEnd - idxStart) / totalPoints;
            const durataTotaleMs = Number(item.durata_ms || 0);
            
            oraPartenza = new Date(new Date(item.start_datetime).getTime() + (durataTotaleMs * ratioPartenza));
            oraArrivo = new Date(oraPartenza.getTime() + (durataTotaleMs * ratioSegmento));
            distanzaSegmentoKm = Number(item.distanza || 0) * ratioSegmento;
            console.log(`✅ [FORMATTER] Corsa ${item.id}: Orari ricalcolati via Redis.`);
          } else {
            console.log(`ℹ️ [FORMATTER] Corsa ${item.id}: Nessun match ZSET, uso default.`);
          }
        }

        let prezzo = 0;
        try {
          prezzo = await calcolaPrezzo(item, richiesta.posti_richiesti, item.stato, distanzaSegmentoKm, Number(item.distanza || 0));
        } catch (err) { console.error(`❌ [FORMATTER] Errore calcolo prezzo corsa ${item.id}:`, err); }

        const result = {
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
          percorsoVisualizzato: isCorsa ? item.decodedCoords : null 
        };

        return result;
      } catch (err) {
        console.error(`💥 [FORMATTER] Errore critico elaborazione item:`, err);
        return null; // Ritorna null per filtrarlo poi
      }
    })
  );

  const filteredResults = results.filter(r => r !== null);
  console.log(`🏁 [FORMATTER] Risultati finali pronti: ${filteredResults.length}`);
  return filteredResults;
}