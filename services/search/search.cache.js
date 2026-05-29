import { pool } from '../../db/db.js';

// --- OGGETTO CONTENITORE SINGOLO (Singleton) ---
export const CacheStore = {
  veicoliCache: new Map(),
  disponibilitaCache: new Map(),
  corseCache: new Map(),
  recensioniCache: new Map(),
  pendingCache: new Map()
};

export const TOP_RESULTS = 10;

// --- GETTER ---
export const getVeicoliMap = () => CacheStore.veicoliCache;
export const getDisponibilitaMap = () => CacheStore.disponibilitaCache;
export const getCorseMap = () => CacheStore.corseCache;
export const getPendingMap = () => CacheStore.pendingCache;
export const getRecensioniCache = () => Object.fromEntries(CacheStore.recensioniCache);

// --- GESTIONE RECENSIONI ---
export const updateRecensioneCache = (conducenteId, media, totale) => {
  CacheStore.recensioniCache.set(conducenteId, { media: Number(media), totale: Number(totale) });
};

// --- GESTIONE CORSE ---
export const upsertCorsa = (c) => {
  const oldData = CacheStore.corseCache.get(c.id) || {};
  CacheStore.corseCache.set(c.id, {
    ...oldData,
    ...c,
    percorso_polyline: c.percorso_polyline || oldData.percorso_polyline,
    path_geohashes: Array.isArray(c.path_geohashes) ? c.path_geohashes : (c.path_geohashes || []),
    picco_occupazione: Number(c.picco_occupazione ?? oldData.picco_occupazione ?? 0)
  });
};
export const removeCorsa = (corsaId) => CacheStore.corseCache.delete(corsaId);

// --- GESTIONE VEICOLI ---
export const upsertVeicolo = (v) => {
  const oldData = CacheStore.veicoliCache.get(v.id) || {};
  const newData = { 
    ...oldData, 
    ...v,
    marca: v.marca ?? oldData.marca ?? 'N/D',
    modello: v.modello ?? oldData.modello ?? 'N/D',
    tipo: v.tipo ?? oldData.tipo ?? 'citycar'
  };
  CacheStore.veicoliCache.set(v.id, newData);
};
export const removeVeicolo = (veicoloId) => CacheStore.veicoliCache.delete(veicoloId);

// --- GESTIONE DISPONIBILITÀ ---
export const upsertDisponibilita = (d) => CacheStore.disponibilitaCache.set(d.id, d);
export const removeDisponibilita = (disponibilitaId) => CacheStore.disponibilitaCache.delete(disponibilitaId);

// --- GESTIONE PENDING ---
export const upsertPending = (p) => CacheStore.pendingCache.set(p.id, p);
export const removePending = (id) => CacheStore.pendingCache.delete(id);

// --- CARICAMENTO ---
export async function loadCachesUltra(force = false) {
  if (!force && CacheStore.veicoliCache.size > 0 && CacheStore.corseCache.size > 0) return;

  const client = await pool.connect();
  try {
    console.log("🔄 Inizio sincronizzazione cache globale...");

    const cRes = await client.query(`
      SELECT c.*, 
             ST_Y(c.origine::geometry) AS origine_lat, ST_X(c.origine::geometry) AS origine_lon, 
             ST_Y(c.destinazione::geometry) AS dest_lat, ST_X(c.destinazione::geometry) AS dest_lon,
             (SELECT COALESCE(MAX(occ), 0) FROM (SELECT SUM(posti_richiesti) as occ FROM prenotazioni WHERE corsa_id = c.id GROUP BY start_index_polyline) as sub) as picco_occupazione
      FROM corse c WHERE c.stato IN ('prenotabile', 'in_corso')
    `);
    
    if (force) CacheStore.corseCache.clear();
    cRes.rows.forEach(c => upsertCorsa(c));

    const vRes = await client.query(`
      SELECT id, driver_id, COALESCE(marca, 'N/D') as marca, modello, posti_totali, tipo,
             ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon 
      FROM veicolo
    `);
    
    if (force) CacheStore.veicoliCache.clear();
    vRes.rows.forEach(v => upsertVeicolo(v));

    const rRes = await client.query(`SELECT conducente_id, media_voto, totale_recensioni FROM media_recensioni_cache`);
    rRes.rows.forEach(r => updateRecensioneCache(r.conducente_id, r.media_voto, r.totale_recensioni));

    const dRes = await client.query(`SELECT d.*, v.driver_id FROM disponibilita_veicolo d JOIN veicolo v ON d.veicolo_id = v.id`);
    
    if (force) CacheStore.disponibilitaCache.clear();
    dRes.rows.forEach(d => upsertDisponibilita(d));

    console.log(`📦 [CACHE] Sincronizzazione completata.`);
  } catch (err) {
    console.error("❌ Errore critico nel caricamento cache:", err);
    throw err;
  } finally {
    client.release();
  }
}