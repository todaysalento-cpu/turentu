import { pool } from '../../db/db.js';
import polyline from 'polyline';
import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js'; 

export const CacheStore = {
  veicoliCache: new Map(),
  disponibilitaCache: new Map(),
  corseCache: new Map(),
  recensioniCache: new Map(),
  pendingCache: new Map(),
  prenotazioniCache: new Map() 
};

// SlotIndex rimane solo se strettamente necessario per la logica di business,
// altrimenti consiglio di spostare anche questo in Redis.
export const SlotIndex = new Map(); 

const GEOHASH_PRECISION_TRATTA = 7;

// --- LOGICA CALCOLO STATO ---
// (Mantenuta invariata per compatibilità)
export function calcolaStatoDisponibilita(d) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const giorniEsclusiNum = Array.isArray(d.giorni_esclusi) ? d.giorni_esclusi.map(Number) : [];
    if (giorniEsclusiNum.includes(dayOfWeek) || giorniEsclusiNum.length >= 7) return false;

    if (Array.isArray(d.inattivita)) {
        for (const i of d.inattivita) {
            const start = new Date(i.start);
            const end = new Date(i.fine);
            if (now >= start && now <= end) return false;
        }
    }

    const startDate = new Date(d.start);
    const endDate = new Date(d.fine);
    const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
    const endMinutes = endDate.getHours() * 60 + endDate.getMinutes();

    if (currentMinutes < startMinutes || currentMinutes > endMinutes) return false;

    return true;
}

// --- GESTIONE DATI ---
export const upsertCorsa = async (c) => {
  const oldData = CacheStore.corseCache.get(c.id);
  
  let decodedCoords = oldData?.decodedCoords || [];
  let turfLine = oldData?.turfLine;
  
  if (c.percorso_polyline) {
    try {
      const raw = polyline.decode(c.percorso_polyline);
      decodedCoords = raw.map(p => [Number(p[1]), Number(p[0])]); 
      turfLine = turf.lineString(decodedCoords);
    } catch (e) { console.error(`Errore decodifica polyline ${c.id}:`, e); }
  }

  const lat = decodedCoords.length > 0 ? decodedCoords[0][1] : 0;
  const lon = decodedCoords.length > 0 ? decodedCoords[0][0] : 0;

  const newCorsa = {
    ...(oldData || {}), ...c, id: c.id, 
    localitaOrigine: c.origine_address, 
    localitaDestinazione: c.destinazione_address,
    prezzo: Number(c.prezzo_fisso ?? oldData?.prezzo ?? 0), 
    oraPartenza: c.start_datetime, 
    oraArrivo: c.arrivo_datetime,
    lat, lon, decodedCoords, turfLine
  };
  
  CacheStore.corseCache.set(c.id, newCorsa);

  if (redisClient) {
    // Pipeline per atomicità delle scritture Redis
    const pipeline = redisClient.multi();
    
    // 1. Aggiorna indice geospaziale (prossimità)
    if (lat !== 0 && lon !== 0) {
        pipeline.geoAdd('corse_geo_index', { longitude: lon, latitude: lat, member: c.id.toString() });
    }
    
    // 2. Aggiorna ZSET (tratta)
    const zKey = `corsa:percorso_hash:${c.id}`;
    pipeline.del(zKey);
    decodedCoords.forEach((coord, idx) => {
        const hash = ngeohash.encode(coord[1], coord[0], GEOHASH_PRECISION_TRATTA);
        pipeline.zAdd(zKey, { score: idx, value: hash });
    });
    
    await pipeline.exec();
  }
};

export const removeCorsa = async (corsaId) => {
    CacheStore.corseCache.delete(corsaId);
    CacheStore.prenotazioniCache.delete(corsaId);
    if (redisClient) {
        // Pulizia totale da Redis
        await redisClient.zRem('corse_geo_index', corsaId.toString());
        await redisClient.del(`corsa:prenotazioni:${corsaId}`);
        await redisClient.del(`corsa:percorso_hash:${corsaId}`);
    }
};

export async function loadCachesUltra(force = false) {
  if (!force && CacheStore.corseCache.size > 0) return;
  const client = await pool.connect();
  try {
    console.log("🔄 Sincronizzazione cache in corso...");
    
    // Pulizia totale Redis per evitare residui tra riavvii
    if (redisClient) {
        await redisClient.del('corse_geo_index');
        // Nota: Qui potresti voler pulire anche i ZSET esistenti se sono persistenti
    }

    const cRes = await client.query(`SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso')`);
    for (const c of cRes.rows) await upsertCorsa(c);
    
    console.log(`📦 [CACHE] Pronta. Corse caricate: ${CacheStore.corseCache.size}`);
  } catch (err) {
    console.error("❌ Errore durante il caricamento cache:", err);
  } finally { 
    client.release(); 
  }
}