import ngeohash from 'ngeohash';
import { pool } from '../../db/db.js';

const GEOHASH_PRECISION = 5;
export const TOP_RESULTS = 10;

// --- STRUTTURE CACHE (Map per accesso O(1)) ---
let veicoliCache = new Map();
let disponibilitaCache = new Map();
let corseCache = new Map();

// --- GETTER ---
export const getVeicoliCache = () => veicoliCache;
export const getDisponibilitaCache = () => disponibilitaCache;
export const getCorseCache = () => corseCache;

// --- HELPERS ---
const safeParseJSON = (str) => {
  try { return typeof str === 'string' ? JSON.parse(str) : (str || []); } 
  catch { return []; }
};

const encodeGeohash = (lat, lon) => {
  if (lat == null || lon == null) return null;
  return ngeohash.encode(lat, lon, GEOHASH_PRECISION);
};

// --- METODI DI AGGIORNAMENTO PUNTUALE (Write-Through) ---

export const upsertVeicolo = (v) => {
  veicoliCache.set(v.id, {
    ...v,
    tipo: v.tipo ?? 'citycar',
    geohash: encodeGeohash(v.lat, v.lon),
    servizi: Array.isArray(v.servizi) ? v.servizi : safeParseJSON(v.servizi)
  });
};

export const upsertDisponibilita = (d) => {
  disponibilitaCache.set(d.id, {
    ...d,
    giorni_esclusi: Array.isArray(d.giorni_esclusi) ? d.giorni_esclusi : safeParseJSON(d.giorni_esclusi),
    inattivita: Array.isArray(d.inattivita) ? d.inattivita : safeParseJSON(d.inattivita)
  });
};

export const upsertCorsa = (c) => {
  corseCache.set(c.id, {
    ...c,
    geohashOrigine: encodeGeohash(c.origine_lat, c.origine_lon),
    geohashDest: encodeGeohash(c.dest_lat, c.dest_lon)
  });
};

export const removeVeicolo = (id) => veicoliCache.delete(id);
export const removeDisponibilita = (id) => disponibilitaCache.delete(id);
export const removeCorsa = (id) => corseCache.delete(id);

// --- CARICAMENTO INIZIALE ---
export async function loadCachesUltra() {
  if (veicoliCache.size > 0) return;

  const client = await pool.connect();
  try {
    // 1. Veicoli
    const vRes = await client.query(`
      SELECT id, driver_id, modello, tipo, posti_totali, servizi, 
             ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon 
      FROM veicolo
    `);
    vRes.rows.forEach(v => upsertVeicolo(v));

    // 2. Disponibilità (con join per ottenere il driver_id)
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

    console.log(`📦 Cache caricate: Veicoli:${veicoliCache.size}, Disp:${disponibilitaCache.size}, Corse:${corseCache.size}`);
  } finally {
    client.release();
  }
}

// --- UTILI ---
export function filterCorse({ veicoloId, clienteId }) {
  let result = Array.from(corseCache.values());
  
  if (veicoloId) result = result.filter(c => c.veicolo_id === veicoloId);
  if (clienteId) result = result.filter(c => c.cliente_id === clienteId);
  
  return result.slice(0, TOP_RESULTS);
}