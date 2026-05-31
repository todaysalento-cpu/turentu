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

export const removeVeicolo = (id) => CacheStore.veicoliCache.delete(id);

export const upsertDisponibilita = (d) => {
  d.disponibile = calcolaStatoDisponibilita(d);
  CacheStore.disponibilitaCache.set(d.id, d);
};

export const removeDisponibilita = (id) => CacheStore.disponibilitaCache.delete(id);

export const upsertPrenotazione = async (p) => {
    if (!CacheStore.prenotazioniCache.has(p.corsa_id)) {
        CacheStore.prenotazioniCache.set(p.corsa_id, []);
    }
    CacheStore.prenotazioniCache.get(p.corsa_id).push(p);
    if (redisClient) {
        await redisClient.hSet(`corsa:prenotazioni:${p.corsa_id}`, p.id || Math.random().toString(), JSON.stringify(p));
    }
};

// --- CORE: CORSE (INDICE INVERSO) ---
export const upsertCorsa = async (c) => {
  const oldData = CacheStore.corseCache.get(c.id);
  let decodedCoords = oldData?.decodedCoords || [];
  
  if (c.percorso_polyline) {
    try {
      const raw = polyline.decode(c.percorso_polyline);
      decodedCoords = raw.map(p => [Number(p[1]), Number(p[0])]); 
    } catch (e) { console.error(`Errore decodifica polyline ${c.id}:`, e); }
  }

  const lat = decodedCoords.length > 0 ? decodedCoords[0][1] : 0;
  const lon = decodedCoords.length > 0 ? decodedCoords[0][0] : 0;
  
  CacheStore.corseCache.set(c.id, { ...oldData, ...c, lat, lon, decodedCoords });

  if (redisClient) {
    const pipeline = redisClient.multi();
    // Pulizia vecchio indice
    pipeline.zRem('corse_geo_index', c.id.toString());
    
    // Indicizzazione punti estremi
    if (lat !== 0 && lon !== 0) {
        pipeline.geoAdd('corse_geo_index', { longitude: lon, latitude: lat, member: c.id.toString() });
    }
    
    // Indicizzazione Inversa (Tollerante)
    decodedCoords.forEach((coord) => {
        const hash = ngeohash.encode(coord[1], coord[0], GEOHASH_PRECISION_TRATTA);
        const area = ngeohash.neighbors(hash);
        area.push(hash); // Include il centro + gli 8 vicini
        
        area.forEach(h => {
            pipeline.sAdd(`corsa_in_area:${h}`, c.id.toString());
        });
    });
    
    await pipeline.exec();
  }
};

export const removeCorsa = async (corsaId) => {
    CacheStore.corseCache.delete(corsaId);
    CacheStore.prenotazioniCache.delete(corsaId);
    if (redisClient) {
        await redisClient.zRem('corse_geo_index', corsaId.toString());
        await redisClient.del(`corsa:prenotazioni:${corsaId}`);
        // Nota: per pulizia totale in produzione, si dovrebbe scansionare 
        // le chiavi corsa_in_area:*, ma per ora è sufficiente rimuovere il riferimento.
    }
};

// --- SYNC ENGINE ---
export async function loadCachesUltra(force = false) {
  if (!force && CacheStore.corseCache.size > 0) return;
  const client = await pool.connect();
  try {
    console.log("🔄 Sincronizzazione cache in corso...");
    const cRes = await client.query(`SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso')`);
    for (const c of cRes.rows) await upsertCorsa(c);
    
    // ... (resto dei caricamenti: prenotazioni, veicoli, ecc.)
    console.log(`📦 [CACHE] Pronta. Corse caricate: ${CacheStore.corseCache.size}`);
  } catch (err) {
    console.error("❌ Errore sincronizzazione:", err);
  } finally { client.release(); }
}