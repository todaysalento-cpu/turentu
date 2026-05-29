import { pool } from '../../db/db.js';

// --- ISTANZE CACHE GLOBALI ---
// L'uso di const garantisce che l'istanza della Map sia la stessa per tutto il ciclo di vita del processo
export const veicoliCache = new Map();
export const disponibilitaCache = new Map();
export const corseCache = new Map();
export const recensioniCache = new Map(); 
export const pendingCache = new Map();

export const TOP_RESULTS = 10;

// --- GESTIONE RECENSIONI ---
export const updateRecensioneCache = (conducenteId, media, totale) => {
  recensioniCache.set(conducenteId, { media: Number(media), totale: Number(totale) });
};

// --- UPSERT & REMOVE CORSA ---
export const upsertCorsa = (c) => {
  const oldData = corseCache.get(c.id) || {};
  corseCache.set(c.id, {
    ...oldData,
    ...c,
    percorso_polyline: c.percorso_polyline || oldData.percorso_polyline,
    path_geohashes: Array.isArray(c.path_geohashes) ? c.path_geohashes : (c.path_geohashes || []),
    picco_occupazione: Number(c.picco_occupazione ?? oldData.picco_occupazione ?? 0)
  });
};

// --- UPSERT & REMOVE VEICOLO (SINGLETON VERSION) ---
export const upsertVeicolo = (v) => {
  const oldData = veicoliCache.get(v.id) || {};
  const newData = { 
    ...oldData, 
    ...v,
    marca: v.marca ?? oldData.marca ?? 'N/D',
    modello: v.modello ?? oldData.modello ?? 'N/D',
    tipo: v.tipo ?? oldData.tipo ?? 'citycar'
  };
  veicoliCache.set(v.id, newData);
};

// --- CARICAMENTO AGGIORNATO E SICURO ---
export async function loadCachesUltra(force = false) {
  // Se la cache è già popolata, non ricaricare a meno che forzato
  if (!force && veicoliCache.size > 0) return;

  const client = await pool.connect();
  try {
    console.log("🔄 Inizio sincronizzazione cache globale...");

    // 1. Carica Corse
    const cRes = await client.query(`
      SELECT c.*, 
             ST_Y(c.origine::geometry) AS origine_lat, ST_X(c.origine::geometry) AS origine_lon, 
             ST_Y(c.destinazione::geometry) AS dest_lat, ST_X(c.destinazione::geometry) AS dest_lon,
             (SELECT COALESCE(MAX(occ), 0) 
              FROM (SELECT SUM(posti_richiesti) as occ FROM prenotazioni WHERE corsa_id = c.id GROUP BY start_index_polyline) as sub) as picco_occupazione
      FROM corse c WHERE c.stato IN ('prenotabile', 'in_corso')
    `);
    
    if (force) corseCache.clear();
    cRes.rows.forEach(c => upsertCorsa(c));

    // 2. Carica Veicoli
    const vRes = await client.query(`
      SELECT id, driver_id, COALESCE(marca, 'N/D') as marca, modello, posti_totali, tipo,
             ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon 
      FROM veicolo
    `);
    
    if (force) veicoliCache.clear();
    vRes.rows.forEach(v => upsertVeicolo(v));

    // 3. Carica Recensioni
    const rRes = await client.query(`SELECT conducente_id, media_voto, totale_recensioni FROM media_recensioni_cache`);
    rRes.rows.forEach(r => updateRecensioneCache(r.conducente_id, r.media_voto, r.totale_recensioni));

    console.log(`📦 [CACHE] Sincronizzazione completata: ${veicoliCache.size} veicoli, ${corseCache.size} corse.`);
  } catch (err) {
    console.error("❌ Errore critico nel caricamento cache:", err);
    throw err;
  } finally {
    client.release();
  }
}