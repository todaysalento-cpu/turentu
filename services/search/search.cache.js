import ngeohash from 'ngeohash';
import { pool } from '../../db/db.js';

const GEOHASH_PRECISION = 5;
export const TOP_RESULTS = 10;

// --- STRUTTURE CACHE (MAP) ---
const veicoliCache = new Map();
const disponibilitaCache = new Map();
const corseCache = new Map();
const recensioniCache = new Map(); 
const pendingCache = new Map();

// --- ESPORTAZIONE MAPPE ---
export const getVeicoliMap = () => veicoliCache;
export const getDisponibilitaMap = () => disponibilitaCache;
export const getCorseMap = () => corseCache;
export const getRecensioniCache = () => Object.fromEntries(recensioniCache);
export const getPendingMap = () => pendingCache;

// --- ESPORTAZIONE ARRAY ---
export const getVeicoliCache = () => Array.from(veicoliCache.values());
export const getDisponibilitaCache = () => Array.from(disponibilitaCache.values());
export const getCorseCache = () => Array.from(corseCache.values());
export const getPendingCache = () => Array.from(pendingCache.values());

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

export const removeCorsa = (corsaId) => corseCache.delete(corsaId);

// --- UPSERT & REMOVE VEICOLO (AGGIORNATO: MERGE INTELLIGENTE) ---
export const upsertVeicolo = (v) => {
  const oldData = veicoliCache.get(v.id) || {};
  veicoliCache.set(v.id, { 
    ...oldData, 
    ...v,
    // Mantiene i valori originali se l'aggiornamento parziale li omette
    marca: v.marca ?? oldData.marca ?? null,
    modello: v.modello ?? oldData.modello ?? null
  });
};

export const removeVeicolo = (veicoloId) => veicoliCache.delete(veicoloId);

// --- UPSERT & REMOVE DISPONIBILITÀ ---
export const upsertDisponibilita = (d) => disponibilitaCache.set(d.id, d);
export const removeDisponibilita = (disponibilitaId) => disponibilitaCache.delete(disponibilitaId);

// --- GESTIONE PENDING ---
export const upsertPending = (p) => pendingCache.set(p.id, p);
export const removePending = (id) => pendingCache.delete(id);

// --- CARICAMENTO AGGIORNATO E SICURO ---
export async function loadCachesUltra(force = false) {
  if (!force && veicoliCache.size > 0 && corseCache.size > 0) return;

  const client = await pool.connect();
  try {
    // 1. Carica Corse
    const cRes = await client.query(`
      SELECT c.*, 
             ST_Y(c.origine::geometry) AS origine_lat, ST_X(c.origine::geometry) AS origine_lon, 
             ST_Y(c.destinazione::geometry) AS dest_lat, ST_X(c.destinazione::geometry) AS dest_lon,
             (SELECT COALESCE(MAX(occ), 0) 
              FROM (
                SELECT SUM(posti_richiesti) as occ 
                FROM prenotazioni 
                WHERE corsa_id = c.id 
                GROUP BY start_index_polyline
              ) as sub) as picco_occupazione
      FROM corse c 
      WHERE c.stato IN ('prenotabile', 'in_corso')
    `);
    
    if (force) corseCache.clear();
    cRes.rows.forEach(c => upsertCorsa(c));

    // 2. Carica Veicoli (Rimosso COALESCE per mantenere null reale e pulito)
    const vRes = await client.query(`
      SELECT id, driver_id, marca, modello, 
             posti_totali, ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon 
      FROM veicolo
    `);
    
    if (force) veicoliCache.clear();
    vRes.rows.forEach(v => upsertVeicolo(v));

    // 3. Carica Recensioni
    const rRes = await client.query(`SELECT conducente_id, media_voto, totale_recensioni FROM media_recensioni_cache`);
    rRes.rows.forEach(r => updateRecensioneCache(r.conducente_id, r.media_voto, r.totale_recensioni));

    // 4. Carica Disponibilità
    const dRes = await client.query(`
      SELECT d.*, v.driver_id 
      FROM disponibilita_veicolo d
      JOIN veicolo v ON d.veicolo_id = v.id
    `);
    
    if (force) disponibilitaCache.clear();
    dRes.rows.forEach(d => upsertDisponibilita(d));

    console.log(`📦 [CACHE] Sincronizzazione completata: ${corseCache.size} corse, ${veicoliCache.size} veicoli, ${disponibilitaCache.size} slot, ${recensioniCache.size} recensioni.`);
  } catch (err) {
    console.error("❌ Errore critico nel caricamento cache:", err);
    throw err;
  } finally {
    client.release();
  }
}