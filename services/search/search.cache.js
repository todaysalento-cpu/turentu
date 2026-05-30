import { pool } from '../../db/db.js';
import polyline from 'polyline';
import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js'; 

// --- OGGETTO CONTENITORE SINGOLO (Singleton) ---
export const CacheStore = {
  veicoliCache: new Map(),
  disponibilitaCache: new Map(),
  corseCache: new Map(),
  recensioniCache: new Map(),
  pendingCache: new Map(),
  prenotazioniCache: new Map() 
};

export const GeoIndex = new Map(); 
export const SlotIndex = new Map(); 
export const TOP_RESULTS = 10;
const GEOHASH_PRECISION = 4;

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

// --- GETTER ---
export const getVeicoliCache = () => Array.from(CacheStore.veicoliCache.values());
export const getCorseCache = () => Array.from(CacheStore.corseCache.values());
export const getDisponibilitaCache = () => Array.from(CacheStore.disponibilitaCache.values());
export const getDisponibilitaMap = () => CacheStore.disponibilitaCache;
export const getPendingCache = () => Array.from(CacheStore.pendingCache.values());
export const getPrenotazioniByCorsa = (corsaId) => CacheStore.prenotazioniCache.get(corsaId) || [];

// --- GESTIONE DATI ---
export const upsertPending = (p) => CacheStore.pendingCache.set(p.id, p);
export const removePending = (id) => CacheStore.pendingCache.delete(id);

export const upsertPrenotazione = async (p) => {
    if (!CacheStore.prenotazioniCache.has(p.corsa_id)) {
        CacheStore.prenotazioniCache.set(p.corsa_id, []);
    }
    CacheStore.prenotazioniCache.get(p.corsa_id).push(p);

    if (redisClient) {
        await redisClient.hSet(`corsa:prenotazioni:${p.corsa_id}`, p.id || Math.random().toString(), JSON.stringify(p));
    }
};

export const upsertDisponibilita = (d) => {
  const v = CacheStore.veicoliCache.get(d.veicolo_id);
  d.disponibile = calcolaStatoDisponibilita(d);
  
  const sStart = new Date(d.start);
  const sEnd = new Date(d.fine);
  d.startMin = sStart.getHours() * 60 + sStart.getMinutes();
  d.endMin = sEnd.getHours() * 60 + sEnd.getMinutes();

  CacheStore.disponibilitaCache.set(d.id, d);

  if (v && v.lat && v.lon) {
    const hash = ngeohash.encode(v.lat, v.lon, GEOHASH_PRECISION);
    if (!SlotIndex.has(hash)) SlotIndex.set(hash, new Set());
    SlotIndex.get(hash).add(d.id);
  }
};

export const removeDisponibilita = (id) => {
    if (CacheStore.disponibilitaCache.has(id)) {
        const d = CacheStore.disponibilitaCache.get(id);
        CacheStore.disponibilitaCache.delete(id);
        const v = CacheStore.veicoliCache.get(d.veicolo_id);
        if (v && v.lat && v.lon) {
            const hash = ngeohash.encode(v.lat, v.lon, GEOHASH_PRECISION);
            if (SlotIndex.has(hash)) {
                SlotIndex.get(hash).delete(id);
            }
        }
    }
};

export const upsertVeicolo = (v) => {
  const normalized = { ...v, lat: Number(v.lat || 0), lon: Number(v.lon || 0) };
  CacheStore.veicoliCache.set(v.id, { ...(CacheStore.veicoliCache.get(v.id) || {}), ...normalized });
};

export const removeVeicolo = (id) => {
    return CacheStore.veicoliCache.delete(id);
};

// --- GESTIONE CORSE ---
export const upsertCorsa = async (c) => {
  const oldData = CacheStore.corseCache.get(c.id);

  if (oldData?.path_geohashes) {
    oldData.path_geohashes.forEach(h => {
        const prefix = h.substring(0, GEOHASH_PRECISION);
        GeoIndex.get(prefix)?.delete(c.id);
    });
  }
  
  let geohashes = typeof c.path_geohashes === 'string' ? JSON.parse(c.path_geohashes || '[]') : (c.path_geohashes || []);
  let decodedCoords = oldData?.decodedCoords;
  let bbox = oldData?.bbox;
  let turfLine = oldData?.turfLine;
  
  if (c.percorso_polyline && c.percorso_polyline !== oldData?.percorso_polyline) {
    try {
      const raw = polyline.decode(c.percorso_polyline);
      decodedCoords = raw.map(p => [Number(p[1]), Number(p[0])]); 
      turfLine = turf.lineString(decodedCoords);
      const lats = raw.map(p => p[0]);
      const lons = raw.map(p => p[1]);
      bbox = { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };
    } catch (e) { console.error(`Errore decodifica ${c.id}:`, e); }
  }

  const newCorsa = {
    ...(oldData || {}), ...c, id: c.id, localitaOrigine: c.origine_address, localitaDestinazione: c.destinazione_address,
    prezzo: Number(c.prezzo_fisso ?? oldData?.prezzo ?? 0), oraPartenza: c.start_datetime, oraArrivo: c.arrivo_datetime,
    distanza: Number(c.distanza || oldData?.distanza || 0), tipo_corsa: c.tipo_corsa || oldData?.tipo_corsa || 'standard',
    veicolo_id: Number(c.veicolo_id || oldData?.veicolo_id), decodedCoords, bbox, turfLine, path_geohashes: geohashes,
    posti_totali: c.posti_totali, posti_prenotati: c.posti_prenotati,
    lat: Number(c.lat || oldData?.lat || 0), lon: Number(c.lon || oldData?.lon || 0)
  };
  
  CacheStore.corseCache.set(c.id, newCorsa);

  if (redisClient && newCorsa.lat && newCorsa.lon) {
    await redisClient.geoAdd('corse_geo_index', {
        longitude: newCorsa.lon,
        latitude: newCorsa.lat,
        member: c.id.toString()
    });
  }
  
  geohashes.forEach(h => {
    const prefix = h.substring(0, GEOHASH_PRECISION);
    if (!GeoIndex.has(prefix)) GeoIndex.set(prefix, new Set());
    GeoIndex.get(prefix).add(c.id);
  });
};

export const removeCorsa = async (corsaId) => {
    const corsa = CacheStore.corseCache.get(corsaId);
    if (corsa) {
        CacheStore.corseCache.delete(corsaId);
        CacheStore.prenotazioniCache.delete(corsaId);
        if (redisClient) {
            await redisClient.zRem('corse_geo_index', corsaId.toString());
            await redisClient.del(`corsa:prenotazioni:${corsaId}`);
        }
        if (corsa.path_geohashes) {
            corsa.path_geohashes.forEach(h => {
                const prefix = h.substring(0, GEOHASH_PRECISION);
                GeoIndex.get(prefix)?.delete(corsaId);
            });
        }
    }
};

export async function loadCachesUltra(force = false) {
  if (!force && CacheStore.corseCache.size > 0 && CacheStore.disponibilitaCache.size > 0) return;
  const client = await pool.connect();
  try {
    console.log("🔄 Sincronizzazione cache e Redis...");
    if (redisClient) await redisClient.del('corse_geo_index');

    // Query corretta per il tuo schema DB attuale
    const cRes = await client.query(`SELECT * FROM corse WHERE stato IN ('prenotabile', 'in_corso')`);
    for (const c of cRes.rows) await upsertCorsa({ ...c, lat: 0, lon: 0 });

    const pRes = await client.query(`SELECT corsa_id, id, posti_richiesti, start_index_polyline, end_index_polyline FROM prenotazioni`);
    CacheStore.prenotazioniCache.clear();
    for (const p of pRes.rows) await upsertPrenotazione(p);

    const vRes = await client.query(`SELECT id, driver_id, marca, modello, posti_totali, tipo FROM veicolo`);
    vRes.rows.forEach(v => upsertVeicolo({ ...v, lat: 0, lon: 0 }));
    
    const dRes = await client.query(`SELECT * FROM disponibilita_veicolo`);
    dRes.rows.forEach(d => upsertDisponibilita(d));
    
    console.log(`📦 [CACHE] Pronta. Redis sincronizzato.`);
  } finally { client.release(); }
}