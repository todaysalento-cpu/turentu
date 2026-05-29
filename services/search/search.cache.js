import ngeohash from 'ngeohash';
import { pool } from '../../db/db.js';

const GEOHASH_PRECISION = 5;
export const TOP_RESULTS = 10;

// --- STRUTTURE CACHE (MAP) ---
const veicoliCache = new Map();
const disponibilitaCache = new Map();
const corseCache = new Map();
const recensioniCache = new Map(); 

// --- ESPORTAZIONE MAPPE ---
export const getVeicoliMap = () => veicoliCache;
export const getDisponibilitaMap = () => disponibilitaCache;
export const getCorseMap = () => corseCache;
export const getRecensioniCache = () => Object.fromEntries(recensioniCache);

// --- ESPORTAZIONE ARRAY ---
export const getVeicoliCache = () => Array.from(veicoliCache.values());
export const getDisponibilitaCache = () => Array.from(disponibilitaCache.values());
export const getCorseCache = () => Array.from(corseCache.values());

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

// --- UPSERT & REMOVE VEICOLO ---
export const upsertVeicolo = (v) => veicoliCache.set(v.id, { ...v });
export const removeVeicolo = (veicoloId) => veicoliCache.delete(veicoloId);

// --- UPSERT & REMOVE DISPONIBILITÀ ---
export const upsertDisponibilita = (d) => disponibilitaCache.set(d.id, d);
export const removeDisponibilita = (disponibilitaId) => disponibilitaCache.delete(disponibilitaId);

// --- CARICAMENTO ---
export async function loadCachesUltra(force = false) {
  if (!force && veicoliCache.size > 0 && corseCache.size > 0) return;

  const client = await pool.connect();
  try {
    // 1. Carica Corse
    // CORRETTO: Sostituito 'start_index' con 'start_index_polyline' che è la colonna corretta
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
    
    // Pulizia preventiva cache se forziamo il reload
    if (force) corseCache.clear();
    cRes.rows.forEach(c => upsertCorsa(c));

    // 2. Carica Veicoli
    const vRes = await client.query(`SELECT id, driver_id, modello, posti_totali, ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon FROM veicolo`);
    if (force) veicoliCache.clear();
    vRes.rows.forEach(v => upsertVeicolo(v));

    // 3. Carica Recensioni
    const rRes = await client.query(`SELECT conducente_id, media_voto, totale_recensioni FROM media_recensioni_cache`);
    rRes.rows.forEach(r => updateRecensioneCache(r.conducente_id, r.media_voto, r.totale_recensioni));

    console.log(`📦 [CACHE] Sincronizzazione completata: ${corseCache.size} corse, ${veicoliCache.size} veicoli, ${recensioniCache.size} recensioni.`);
  } catch (err) {
    console.error("❌ Errore critico nel caricamento cache:", err);
    throw err; // Rilanciamo l'errore per bloccare l'avvio del server se la cache è essenziale
  } finally {
    client.release();
  }
}