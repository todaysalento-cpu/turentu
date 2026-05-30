import { pool } from '../../db/db.js';
import polyline from 'polyline';
import ngeohash from 'ngeohash';

// --- OGGETTO CONTENITORE SINGOLO (Singleton) ---
export const CacheStore = {
  veicoliCache: new Map(),
  disponibilitaCache: new Map(),
  corseCache: new Map(),
  recensioniCache: new Map(),
  pendingCache: new Map()
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

// --- GETTER (Necessari per le dipendenze esterne) ---
export const getVeicoliMap = () => CacheStore.veicoliCache;
export const getDisponibilitaMap = () => CacheStore.disponibilitaCache;
export const getCorseMap = () => CacheStore.corseCache;
export const getVeicoliCache = () => Array.from(CacheStore.veicoliCache.values());
export const getCorseCache = () => Array.from(CacheStore.corseCache.values());
export const getDisponibilitaCache = () => Array.from(CacheStore.disponibilitaCache.values());

// --- GESTIONE DATI ---
export const upsertPending = (p) => CacheStore.pendingCache.set(p.id, p);
export const removePending = (id) => CacheStore.pendingCache.delete(id);

export const upsertDisponibilita = (d) => {
  const oldD = CacheStore.disponibilitaCache.get(d.id);
  if (oldD) {
      const oldHash = ngeohash.encode(oldD.lat || 0, oldD.lon || 0, GEOHASH_PRECISION);
      SlotIndex.get(oldHash)?.delete(d.id);
  }

  d.disponibile = calcolaStatoDisponibilita(d);
  
  const veicolo = CacheStore.veicoliCache.get(d.veicolo_id);
  if (veicolo) {
      d.lat = veicolo.lat;
      d.lon = veicolo.lon;
      const hash = ngeohash.encode(veicolo.lat, veicolo.lon, GEOHASH_PRECISION);
      if (!SlotIndex.has(hash)) SlotIndex.set(hash, new Set());
      SlotIndex.get(hash).add(d.id);
  }

  CacheStore.disponibilitaCache.set(d.id, d);
};

export const removeDisponibilita = (id) => {
  const d = CacheStore.disponibilitaCache.get(id);
  if (d) {
      const hash = ngeohash.encode(d.lat || 0, d.lon || 0, GEOHASH_PRECISION);
      SlotIndex.get(hash)?.delete(id);
  }
  CacheStore.disponibilitaCache.delete(id);
};

export const upsertVeicolo = (v) => {
  const normalized = { ...v, lat: Number(v.lat), lon: Number(v.lon) };
  CacheStore.veicoliCache.set(v.id, { ...(CacheStore.veicoliCache.get(v.id) || {}), ...normalized });
};

export const removeVeicolo = (id) => CacheStore.veicoliCache.delete(id);

// --- GESTIONE CORSE ---
export const upsertCorsa = (c) => {
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
  
  if (c.percorso_polyline && c.percorso_polyline !== oldData?.percorso_polyline) {
    try {
      const raw = polyline.decode(c.percorso_polyline);
      decodedCoords = raw.map(p => [Number(p[1]), Number(p[0])]); 
      const lats = raw.map(p => p[0]);
      const lons = raw.map(p => p[1]);
      bbox = { 
        minLat: Math.min(...lats), maxLat: Math.max(...lats), 
        minLon: Math.min(...lons), maxLon: Math.max(...lons) 
      };
    } catch (e) { console.error(`Errore decodifica ${c.id}:`, e); }
  }

  const newCorsa = {
    ...(oldData || {}),
    ...c,
    id: c.id,
    localitaOrigine: c.origine_address,
    localitaDestinazione: c.destinazione_address,
    prezzo: Number(c.prezzo_fisso ?? oldData?.prezzo ?? 0),
    oraPartenza: c.start_datetime,
    oraArrivo: c.arrivo_datetime,
    distanza: Number(c.distanza || oldData?.distanza || 0),
    decodedCoords,
    bbox,
    path_geohashes: geohashes,
    picco_occupazione: Number(c.picco_occupazione ?? oldData?.picco_occupazione ?? 0),
    posti_totali: c.posti_totali
  };
  
  CacheStore.corseCache.set(c.id, newCorsa);
  
  geohashes.forEach(h => {
    const prefix = h.substring(0, GEOHASH_PRECISION);
    if (!GeoIndex.has(prefix)) GeoIndex.set(prefix, new Set());
    GeoIndex.get(prefix).add(c.id);
  });
};

export const removeCorsa = (corsaId) => {
  const corsa = CacheStore.corseCache.get(corsaId);
  if (corsa?.path_geohashes) {
    corsa.path_geohashes.forEach(h => GeoIndex.get(h.substring(0, GEOHASH_PRECISION))?.delete(corsaId));
  }
  CacheStore.corseCache.delete(corsaId);
};

// --- CARICAMENTO ---
export async function loadCachesUltra(force = false) {
  if (!force && CacheStore.corseCache.size > 0 && CacheStore.disponibilitaCache.size > 0) return;

  const client = await pool.connect();
  try {
    console.log("🔄 Sincronizzazione cache in corso...");
    
    const cRes = await client.query(`SELECT c.* FROM corse c WHERE c.stato IN ('prenotabile', 'in_corso')`);
    cRes.rows.forEach(c => upsertCorsa(c));
    
    const vRes = await client.query(`SELECT id, ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon FROM veicolo`);
    vRes.rows.forEach(v => upsertVeicolo(v));
    
    const dRes = await client.query(`SELECT * FROM disponibilita_veicolo`);
    dRes.rows.forEach(d => upsertDisponibilita(d));
    
    console.log(`📦 [CACHE] Sincronizzazione completata: ${CacheStore.corseCache.size} corse, ${CacheStore.disponibilitaCache.size} slot.`);
  } finally {
    client.release();
  }
}