import { pool } from '../../db/db.js';

// --- OGGETTO CONTENITORE SINGOLO (Singleton) ---
export const CacheStore = {
  veicoliCache: new Map(),
  disponibilitaCache: new Map(),
  corseCache: new Map(),
  recensioniCache: new Map(),
  pendingCache: new Map()
};

// --- INDICE SPAZIALE PER PERFORMANCE ---
// Mappa: 'geohash' -> Set([corsaId1, corsaId2, ...])
export const GeoIndex = new Map(); 

export const TOP_RESULTS = 10;
const GEOHASH_PRECISION = 4; // Deve coincidere con il motore di ricerca

// --- GETTER DIRETTI ---
export const getVeicoliMap = () => CacheStore.veicoliCache;
export const getDisponibilitaMap = () => CacheStore.disponibilitaCache;
export const getCorseMap = () => CacheStore.corseCache;
export const getPendingMap = () => CacheStore.pendingCache;
export const getRecensioniCache = () => Object.fromEntries(CacheStore.recensioniCache);

export const getVeicoliCache = () => Array.from(CacheStore.veicoliCache.values());
export const getCorseCache = () => Array.from(CacheStore.corseCache.values());
export const getDisponibilitaCache = () => Array.from(CacheStore.disponibilitaCache.values());
export const getPendingCache = () => Array.from(CacheStore.pendingCache.values());

// --- GESTIONE RECENSIONI ---
export const updateRecensioneCache = (conducenteId, media, totale) => {
  CacheStore.recensioniCache.set(conducenteId, { media: Number(media), totale: Number(totale) });
};

// --- GESTIONE CORSE ---
export const upsertCorsa = (c) => {
  const oldData = CacheStore.corseCache.get(c.id) || {};
  
  // Pulizia Geohashes
  let geohashes = c.path_geohashes;
  if (typeof geohashes === 'string') {
      try { geohashes = JSON.parse(geohashes); } catch (e) { geohashes = []; }
  }
  const cleanHashes = Array.isArray(geohashes) ? geohashes : (geohashes || []);

  // Rimuovi vecchi riferimenti dall'indice se la corsa esisteva già
  if (oldData.path_geohashes) {
    oldData.path_geohashes.forEach(h => {
        const prefix = h.substring(0, GEOHASH_PRECISION);
        if (GeoIndex.has(prefix)) {
            GeoIndex.get(prefix).delete(c.id);
        }
    });
  }

  // Aggiorna Cache
  const newCorsa = {
    ...oldData,
    ...c,
    percorso_polyline: c.percorso_polyline || oldData.percorso_polyline,
    path_geohashes: cleanHashes,
    picco_occupazione: Number(c.picco_occupazione ?? oldData.picco_occupazione ?? 0)
  };
  CacheStore.corseCache.set(c.id, newCorsa);

  // Popola Indice
  cleanHashes.forEach(h => {
    const prefix = h.substring(0, GEOHASH_PRECISION);
    if (!GeoIndex.has(prefix)) GeoIndex.set(prefix, new Set());
    GeoIndex.get(prefix).add(c.id);
  });
};

export const removeCorsa = (corsaId) => {
  const corsa = CacheStore.corseCache.get(corsaId);
  if (corsa && Array.isArray(corsa.path_geohashes)) {
    corsa.path_geohashes.forEach(h => {
        const prefix = h.substring(0, GEOHASH_PRECISION);
        if (GeoIndex.has(prefix)) GeoIndex.get(prefix).delete(corsaId);
    });
  }
  CacheStore.corseCache.delete(corsaId);
};

// --- GESTIONE VEICOLI ---
export const upsertVeicolo = (v) => {
  const oldData = CacheStore.veicoliCache.get(v.id) || {};
  CacheStore.veicoliCache.set(v.id, { 
    ...oldData, 
    ...v,
    marca: v.marca ?? oldData.marca ?? 'N/D',
    modello: v.modello ?? oldData.modello ?? 'N/D',
    tipo: v.tipo ?? oldData.tipo ?? 'citycar'
  });
};
export const removeVeicolo = (veicoloId) => CacheStore.veicoliCache.delete(veicoloId);

// --- GESTIONE DISPONIBILITÀ E PENDING ---
export const upsertDisponibilita = (d) => CacheStore.disponibilitaCache.set(d.id, d);
export const removeDisponibilita = (disponibilitaId) => CacheStore.disponibilitaCache.delete(disponibilitaId);
export const upsertPending = (p) => CacheStore.pendingCache.set(p.id, p);
export const removePending = (id) => CacheStore.pendingCache.delete(id);

// --- CARICAMENTO ---
export async function loadCachesUltra(force = false) {
  if (!force && CacheStore.corseCache.size > 0) return;

  const client = await pool.connect();
  try {
    console.log("🔄 Inizio sincronizzazione cache con GeoIndex...");

    if (force) {
        CacheStore.corseCache.clear();
        GeoIndex.clear();
    }

    const cRes = await client.query(`
      SELECT c.*, 
             ST_Y(c.origine::geometry) AS origine_lat, ST_X(c.origine::geometry) AS origine_lon, 
             ST_Y(c.destinazione::geometry) AS dest_lat, ST_X(c.destinazione::geometry) AS dest_lon,
             (SELECT COALESCE(MAX(occ), 0) FROM (SELECT SUM(posti_richiesti) as occ FROM prenotazioni WHERE corsa_id = c.id GROUP BY start_index_polyline) as sub) as picco_occupazione
      FROM corse c WHERE c.stato IN ('prenotabile', 'in_corso')
    `);
    cRes.rows.forEach(c => upsertCorsa(c));

    const vRes = await client.query(`SELECT id, driver_id, marca, modello, posti_totali, tipo, ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon FROM veicolo`);
    vRes.rows.forEach(v => upsertVeicolo(v));

    const rRes = await client.query(`SELECT conducente_id, media_voto, totale_recensioni FROM media_recensioni_cache`);
    rRes.rows.forEach(r => updateRecensioneCache(r.conducente_id, r.media_voto, r.totale_recensioni));

    const dRes = await client.query(`SELECT d.*, v.driver_id FROM disponibilita_veicolo d JOIN veicolo v ON d.veicolo_id = v.id`);
    dRes.rows.forEach(d => upsertDisponibilita(d));

    console.log(`📦 [CACHE] Sincronizzazione completata. Corse indicizzate: ${CacheStore.corseCache.size}`);
  } catch (err) {
    console.error("❌ Errore critico nel caricamento cache:", err);
    throw err;
  } finally {
    client.release();
  }
}