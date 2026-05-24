import ngeohash from 'ngeohash';
import { pool } from '../../db/db.js';

const GEOHASH_PRECISION = 5;
export const TOP_RESULTS = 10;

// --- STRUTTURE CACHE ---
const veicoliCache = new Map();
const disponibilitaCache = new Map();
const corseCache = new Map();

// --- GETTER ESPORTATI ---
export const getVeicoliMap = () => veicoliCache;
export const getDisponibilitaMap = () => disponibilitaCache;
export const getCorseMap = () => corseCache;

export const getVeicoliCache = () => Array.from(veicoliCache.values());
export const getDisponibilitaCache = () => Array.from(disponibilitaCache.values());
export const getCorseCache = () => Array.from(corseCache.values());

// --- HELPERS ---
const safeParseJSON = (str) => {
  try { return typeof str === 'string' ? JSON.parse(str) : (str || []); } 
  catch { return []; }
};

const encodeGeohash = (lat, lon) => {
  if (lat == null || lon == null) return null;
  return ngeohash.encode(lat, lon, GEOHASH_PRECISION);
};

// --- AGGIORNAMENTO INTELLIGENTE (Merge con dati esistenti) ---

export const upsertVeicolo = (v) => {
  const oldData = veicoliCache.get(v.id) || {};
  const esiste = veicoliCache.has(v.id);
  
  veicoliCache.set(v.id, {
    ...oldData,      // Mantiene i campi vecchi non sovrascritti
    ...v,            // Sovrascrive con i nuovi dati (es. posti_totali aggiornati)
    tipo: v.tipo ?? oldData.tipo ?? 'citycar',
    geohash: encodeGeohash(v.lat ?? oldData.lat, v.lon ?? oldData.lon),
    servizi: Array.isArray(v.servizi) ? v.servizi : safeParseJSON(v.servizi ?? oldData.servizi)
  });
  
  console.log(`[CACHE][VEICOLO] ${esiste ? 'Aggiornato' : 'Inserito'} ID: ${v.id} | Posti: ${v.posti_totali ?? oldData.posti_totali}`);
};

export const upsertDisponibilita = (d) => {
  const oldData = disponibilitaCache.get(d.id) || {};
  const esiste = disponibilitaCache.has(d.id);
  
  disponibilitaCache.set(d.id, {
    ...oldData,
    ...d,
    giorni_esclusi: Array.isArray(d.giorni_esclusi) ? d.giorni_esclusi : safeParseJSON(d.giorni_esclusi ?? oldData.giorni_esclusi),
    inattivita: Array.isArray(d.inattivita) ? d.inattivita : safeParseJSON(d.inattivita ?? oldData.inattivita)
  });
  console.log(`[CACHE][DISP] ${esiste ? 'Aggiornato' : 'Inserito'} ID: ${d.id}`);
};

export const upsertCorsa = (c) => {
  const oldData = corseCache.get(c.id) || {};
  const esiste = corseCache.has(c.id);
  
  corseCache.set(c.id, {
    ...oldData,
    ...c,
    geohashOrigine: encodeGeohash(c.origine_lat ?? oldData.origine_lat, c.origine_lon ?? oldData.origine_lon),
    geohashDest: encodeGeohash(c.dest_lat ?? oldData.dest_lat, c.dest_lon ?? oldData.dest_lon)
  });
  console.log(`[CACHE][CORSA] ${esiste ? 'Aggiornato' : 'Inserito'} ID: ${c.id}`);
};

// --- RIMOZIONE ---
export const removeVeicolo = (id) => { if (veicoliCache.delete(id)) console.log(`[CACHE][VEICOLO] Rimosso ID: ${id}`); };
export const removeDisponibilita = (id) => { if (disponibilitaCache.delete(id)) console.log(`[CACHE][DISP] Rimossa ID: ${id}`); };
export const removeCorsa = (id) => { if (corseCache.delete(id)) console.log(`[CACHE][CORSA] Rimossa ID: ${id}`); };

// --- CARICAMENTO ---
export async function loadCachesUltra(force = false) {
  if (!force && veicoliCache.size > 0) return;

  const client = await pool.connect();
  try {
    console.log(`[CACHE] Caricamento in corso...`);
    if (force) {
      veicoliCache.clear();
      disponibilitaCache.clear();
      corseCache.clear();
    }
    
    // 1. Veicoli
    const vRes = await client.query(`
      SELECT id, driver_id, modello, tipo, posti_totali, servizi, 
             ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon 
      FROM veicolo
    `);
    vRes.rows.forEach(v => upsertVeicolo(v));

    // 2. Disponibilità
    const dRes = await client.query(`
      SELECT d.*, v.driver_id 
      FROM disponibilita_veicolo d
      JOIN veicolo v ON v.id = d.veicolo_id
    `);
    dRes.rows.forEach(d => upsertDisponibilita(d));

    // 3. Corse
    const cRes = await client.query(`
      SELECT c.*, ST_Y(c.origine::geometry) AS origine_lat, ST_X(c.origine::geometry) AS origine_lon,
             ST_Y(c.destinazione::geometry) AS dest_lat, ST_X(c.destinazione::geometry) AS dest_lon,
             COALESCE(EXTRACT(EPOCH FROM c.durata), 0) AS durata,
             COALESCE(c.posti_prenotati, 0) AS posti_prenotati,
             COALESCE(c.primo_posto, 0) AS primo_posto
      FROM corse c WHERE c.stato = 'prenotabile'
    `);
    cRes.rows.forEach(c => upsertCorsa(c));

    console.log(`📦 [CACHE] Sincronizzazione completata.`);
  } catch (err) {
    console.error("[CACHE] Errore critico:", err);
    throw err;
  } finally {
    client.release();
  }
}

export function filterCorse({ veicoloId, clienteId }) {
  let result = getCorseCache();
  if (veicoloId) result = result.filter(c => c.veicolo_id === veicoloId);
  if (clienteId) result = result.filter(c => c.cliente_id === clienteId);
  return result.slice(0, TOP_RESULTS);
}