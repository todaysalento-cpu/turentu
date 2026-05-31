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
  prenotazioniCache: new Map() 
};

// Precisione 5 (~4.9km). Se non trovi risultati, prova a 4 (~39km) per testare.
const GEOHASH_PRECISION_TRATTA = 5;

// --- LOGICA CALCOLO STATO ---
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
export const upsertVeicolo = (v) => {
  const normalized = { ...v, lat: Number(v.lat || 0), lon: Number(v.lon || 0) };
  CacheStore.veicoliCache.set(v.id, { ...(CacheStore.veicoliCache.get(v.id) || {}), ...normalized });
};

export const upsertPrenotazione = async (p) => {
    if (!CacheStore.prenotazioniCache.has(p.corsa_id)) {
        CacheStore.prenotazioniCache.set(p.corsa_id, []);
    }
    CacheStore.prenotazioniCache.get(p.corsa_id).push(p);
    if (redisClient) {
        await redisClient.hSet(`corsa:prenotazioni:${p.corsa_id}`, p.id || Math.random().toString(), JSON.stringify(p));
    }
};

// --- CORE: CORSE E INDICIZZAZIONE GEOSPAZIALE ---
export const upsertCorsa = async (c) => {
  const oldData = CacheStore.corseCache.get(c.id);
  
  let decodedCoords = oldData?.decodedCoords || [];
  let turfLine = oldData?.turfLine;
  
  if (c.percorso_polyline) {
    try {
      const raw = polyline.decode(c.percorso_polyline);
      // polyline.decode restituisce [lat, lon], convertiamo in [lon, lat] per turf/geohash
      decodedCoords = raw.map(p => [Number(p[1]), Number(p[0])]); 
      turfLine = turf.lineString(decodedCoords);
      console.log(`[SYNC] Corsa ${c.id}: Decodificati ${decodedCoords.length} punti.`);
    } catch (e) { console.error(`Errore decodifica polyline ${c.id}:`, e); }
  }

  const lat = decodedCoords.length > 0 ? decodedCoords[0][1] : 0;
  const lon = decodedCoords.length > 0 ? decodedCoords[0][0] : 0;
  const endLat = decodedCoords.length > 0 ? decodedCoords[decodedCoords.length - 1][1] : 0;
  const endLon = decodedCoords.length > 0 ? decodedCoords[decodedCoords.length - 1][0] : 0;

  const newCorsa = {
    ...(oldData || {}), ...c, id: c.id, 
    lat, lon, decodedCoords, turfLine
  };
  
  CacheStore.corseCache.set(c.id, newCorsa);

  if (redisClient) {
    const pipeline = redisClient.multi();
    pipeline.zRem('corse_geo_index', c.id.toString());
    
    if (lat !== 0 && lon !== 0) {
        pipeline.geoAdd('corse_geo_index', { longitude: lon, latitude: lat, member: c.id.toString() });
    }
    
    const zKey = `corsa:percorso_hash:${c.id}`;
    pipeline.del(zKey);
    
    decodedCoords.forEach((coord, idx) => {
        // coord[0] = lon, coord[1] = lat
        const hash = ngeohash.encode(coord[1], coord[0], GEOHASH_PRECISION_TRATTA);
        pipeline.zAdd(zKey, { score: idx, value: hash });
        
        // Log di debug per il primo e l'ultimo punto della rotta
        if (idx === 0 || idx === decodedCoords.length - 1) {
            console.log(`[DEBUG SYNC] Corsa ${c.id} | Punto ${idx} (${coord[1]}, ${coord[0]}) -> Hash: ${hash}`);
        }
    });
    
    await pipeline.exec();
  }
};

export async function loadCachesUltra(force = false) {
  if (!force && CacheStore.corseCache.size > 0) return;
  const client = await pool.connect();
  try {
    console.log("🔄 Sincronizzazione cache in corso...");
    const cRes = await client.query(`SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso')`);
    for (const c of cRes.rows) await upsertCorsa(c);
    // ... (resto della logica)
    console.log(`📦 [CACHE] Pronta. Corse caricate: ${CacheStore.corseCache.size}`);
  } catch (err) {
    console.error("❌ Errore:", err);
  } finally { client.release(); }
}