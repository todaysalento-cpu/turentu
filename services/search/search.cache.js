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
  console.log(`[CACHE] Veicolo ${v.id} aggiornato | Coord: ${normalized.lat}, ${normalized.lon}`);
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