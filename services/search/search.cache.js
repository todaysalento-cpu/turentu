import { pool } from '../../db/db.js';
import polyline from 'polyline';

// --- OGGETTO CONTENITORE SINGOLO (Singleton) ---
export const CacheStore = {
  veicoliCache: new Map(),
  disponibilitaCache: new Map(),
  corseCache: new Map(),
  recensioniCache: new Map(),
  pendingCache: new Map()
};

export const GeoIndex = new Map(); 
export const TOP_RESULTS = 10;
const GEOHASH_PRECISION = 4;

// --- GETTER ---
export const getVeicoliMap = () => CacheStore.veicoliCache;
export const getDisponibilitaMap = () => CacheStore.disponibilitaCache;
export const getCorseMap = () => CacheStore.corseCache;
export const getVeicoliCache = () => Array.from(CacheStore.veicoliCache.values());
export const getCorseCache = () => Array.from(CacheStore.corseCache.values());
export const getDisponibilitaCache = () => Array.from(CacheStore.disponibilitaCache.values());
export const getPendingCache = () => Array.from(CacheStore.pendingCache.values());
export const getRecensioniCache = () => Object.fromEntries(CacheStore.recensioniCache);

// --- GESTIONE DATI ---
export const upsertPending = (p) => CacheStore.pendingCache.set(p.id, p);
export const removePending = (id) => CacheStore.pendingCache.delete(id);
export const upsertDisponibilita = (d) => CacheStore.disponibilitaCache.set(d.id, d);
export const removeDisponibilita = (id) => CacheStore.disponibilitaCache.delete(id);
export const upsertVeicolo = (v) => CacheStore.veicoliCache.set(v.id, { ...(CacheStore.veicoliCache.get(v.id) || {}), ...v });
export const removeVeicolo = (id) => CacheStore.veicoliCache.delete(id);
export const updateRecensioneCache = (conducenteId, media, totale) => {
  CacheStore.recensioniCache.set(conducenteId, { media: Number(media), totale: Number(totale) });
};

// --- GESTIONE CORSE (Aggiornata con Inversione Coords) ---
export const upsertCorsa = (c) => {
  const oldData = CacheStore.corseCache.get(c.id) || {};
  let geohashes = typeof c.path_geohashes === 'string' ? JSON.parse(c.path_geohashes || '[]') : (c.path_geohashes || []);
  
  let decodedCoords = oldData.decodedCoords;
  let bbox = oldData.bbox;
  
  if (c.percorso_polyline && c.percorso_polyline !== oldData.percorso_polyline) {
    try {
      const rawCoords = polyline.decode(c.percorso_polyline);
      // INVERSIONE: da [lat, lon] a [lon, lat] per compatibilità Turf/GeoJSON
      decodedCoords = rawCoords.map(p => [p[1], p[0]]); 
      
      const lons = decodedCoords.map(p => p[0]);
      const lats = decodedCoords.map(p => p[1]);
      bbox = { 
        minLat: Math.min(...lats), maxLat: Math.max(...lats), 
        minLon: Math.min(...lons), maxLon: Math.max(...lons) 
      };
    } catch (e) { console.error(`Errore decodifica ${c.id}:`, e); }
  }

  const newCorsa = {
    ...oldData,
    ...c,
    id: c.id,
    localitaOrigine: c.origine_address,
    localitaDestinazione: c.destinazione_address,
    prezzo: Number(c.prezzo_fisso ?? oldData.prezzo ?? 0),
    oraPartenza: c.start_datetime,
    oraArrivo: c.arrivo_datetime,
    distanza: Number(c.distanza || oldData.distanza || 0),
    tipo_corsa: c.tipo_corsa || oldData.tipo_corsa || 'standard',
    veicolo_id: Number(c.veicolo_id || oldData.veicolo_id),
    decodedCoords,
    bbox,
    path_geohashes: geohashes,
    picco_occupazione: Number(c.picco_occupazione ?? oldData.picco_occupazione ?? 0),
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
    
    const cRes = await client.query(`
        SELECT c.*, 
        (SELECT COALESCE(MAX(occ), 0) FROM (SELECT SUM(posti_richiesti) as occ FROM prenotazioni WHERE corsa_id = c.id GROUP BY start_index_polyline) as sub) as picco_occupazione 
        FROM corse c 
        WHERE c.stato IN ('prenotabile', 'in_corso')
    `);
    cRes.rows.forEach(c => upsertCorsa(c));
    
    const vRes = await client.query(`SELECT id, driver_id, marca, modello, posti_totali, tipo, ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon FROM veicolo`);
    vRes.rows.forEach(v => upsertVeicolo(v));
    
    const dRes = await client.query(`SELECT * FROM disponibilita_veicolo`);
    dRes.rows.forEach(d => upsertDisponibilita(d));
    
    console.log(`📦 [CACHE] Sincronizzazione completata: ${CacheStore.corseCache.size} corse, ${CacheStore.disponibilitaCache.size} slot.`);
  } finally {
    client.release();
  }
}