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
export const getVeicoliCache = () => Array.from(CacheStore.veicoliCache.values());
export const getCorseCache = () => Array.from(CacheStore.corseCache.values());

// --- GESTIONE CORSE AGGIORNATA ---
export const upsertCorsa = (c) => {
  const oldData = CacheStore.corseCache.get(c.id) || {};
  
  let geohashes = c.path_geohashes;
  if (typeof geohashes === 'string') {
      try { geohashes = JSON.parse(geohashes); } catch (e) { geohashes = []; }
  }
  const cleanHashes = Array.isArray(geohashes) ? geohashes : (geohashes || []);

  // Pre-decodifica e calcolo Bounding Box
  let decodedCoords = oldData.decodedCoords;
  let bbox = oldData.bbox;
  
  if (c.percorso_polyline && c.percorso_polyline !== oldData.percorso_polyline) {
    try {
      decodedCoords = polyline.decode(c.percorso_polyline);
      const lats = decodedCoords.map(p => p[0]);
      const lons = decodedCoords.map(p => p[1]);
      bbox = {
        minLat: Math.min(...lats), maxLat: Math.max(...lats),
        minLon: Math.min(...lons), maxLon: Math.max(...lons)
      };
    } catch (e) { console.error(`Errore decodifica ${c.id}:`, e); }
  }

  // 4. AGGIORNAMENTO CACHE CON CAMPI PRICING
  const newCorsa = {
    ...oldData,
    ...c,
    // Assicuriamo i campi necessari per il pricing
    distanza: Number(c.distanza || oldData.distanza || 0),
    tipo_corsa: c.tipo_corsa || oldData.tipo_corsa || 'standard',
    veicolo_id: Number(c.veicolo_id || oldData.veicolo_id),
    percorso_polyline: c.percorso_polyline || oldData.percorso_polyline,
    decodedCoords,
    bbox,
    path_geohashes: cleanHashes,
    picco_occupazione: Number(c.picco_occupazione ?? oldData.picco_occupazione ?? 0)
  };
  
  CacheStore.corseCache.set(c.id, newCorsa);

  cleanHashes.forEach(h => {
    const prefix = h.substring(0, GEOHASH_PRECISION);
    if (!GeoIndex.has(prefix)) GeoIndex.set(prefix, new Set());
    GeoIndex.get(prefix).add(c.id);
  });
};

// --- CARICAMENTO ---
export async function loadCachesUltra(force = false) {
  if (!force && CacheStore.corseCache.size > 0) return;

  const client = await pool.connect();
  try {
    console.log("🔄 Sincronizzazione cache in corso...");
    
    // Includiamo esplicitamente 'distanza' e 'tipo_corsa' nella query
    const cRes = await client.query(`
      SELECT c.*, 
             (SELECT COALESCE(MAX(occ), 0) 
              FROM (SELECT SUM(posti_richiesti) as occ FROM prenotazioni WHERE corsa_id = c.id GROUP BY start_index_polyline) as sub
             ) as picco_occupazione
      FROM corse c WHERE c.stato IN ('prenotabile', 'in_corso')
    `);
    
    cRes.rows.forEach(c => upsertCorsa(c));

    // ... (restante logica di caricamento invariata)
    
    console.log(`📦 [CACHE] Caricate ${CacheStore.corseCache.size} corse.`);
  } finally {
    client.release();
  }
}