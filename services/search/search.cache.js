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

// --- AGGIORNAMENTO CON LOG DIAGNOSTICI ---

export const upsertVeicolo = (v) => {
  const oldData = veicoliCache.get(v.id) || {};
  const esiste = veicoliCache.has(v.id);
  
  const newData = {
    ...oldData,
    ...v,
    tipo: v.tipo ?? oldData.tipo ?? 'citycar',
    geohash: encodeGeohash(v.lat ?? oldData.lat, v.lon ?? oldData.lon),
    servizi: Array.isArray(v.servizi) ? v.servizi : safeParseJSON(v.servizi ?? oldData.servizi)
  };

  veicoliCache.set(v.id, newData);
  
  // LOG DI DIAGNOSTICA
  console.log(`[CACHE][VEICOLO][${esiste ? 'UPDATE' : 'INSERT'}] ID: ${v.id}`);
  console.log(`   > Input (DB):    Posti: ${v.posti_totali}, Lat: ${v.lat}`);
  console.log(`   > Cache Finale:  Posti: ${newData.posti_totali}, Geohash: ${newData.geohash}`);
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
  console.log(`[CACHE][DISP][${esiste ? 'UPDATE' : 'INSERT'}] ID: ${d.id}`);
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
  console.log(`[CACHE][CORSA][${esiste ? 'UPDATE' : 'INSERT'}] ID: ${c.id}`);
};

// --- RIMOZIONE ---
export const removeVeicolo = (id) => { 
    if (veicoliCache.delete(id)) console.log(`[CACHE][VEICOLO][DELETE] ID: ${id}`); 
};
export const removeDisponibilita = (id) => { 
    if (disponibilitaCache.delete(id)) console.log(`[CACHE][DISP][DELETE] ID: ${id}`); 
};
export const removeCorsa = (id) => { 
    if (corseCache.delete(id)) console.log(`[CACHE][CORSA][DELETE] ID: ${id}`); 
};

// --- CARICAMENTO ---
export async function loadCachesUltra(force = false) {
  if (!force && veicoliCache.size > 0) return;

  const client = await pool.connect();
  try {
    console.log(`[CACHE] Inizio sincronizzazione completa...`);
    if (force) {
      veicoliCache.clear();
      disponibilitaCache.clear();
      corseCache.clear();
    }
    
    const vRes = await client.query(`SELECT id, driver_id, modello, tipo, posti_totali, servizi, ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon FROM veicolo`);
    vRes.rows.forEach(v => upsertVeicolo(v));

    const dRes = await client.query(`SELECT d.*, v.driver_id FROM disponibilita_veicolo d JOIN veicolo v ON v.id = d.veicolo_id`);
    dRes.rows.forEach(d => upsertDisponibilita(d));

    const cRes = await client.query(`SELECT c.*, ST_Y(c.origine::geometry) AS origine_lat, ST_X(c.origine::geometry) AS origine_lon, ST_Y(c.destinazione::geometry) AS dest_lat, ST_X(c.destinazione::geometry) AS dest_lon, COALESCE(EXTRACT(EPOCH FROM c.durata), 0) AS durata, COALESCE(c.posti_prenotati, 0) AS posti_prenotati, COALESCE(c.primo_posto, 0) AS primo_posto FROM corse c WHERE c.stato = 'prenotabile'`);
    cRes.rows.forEach(c => upsertCorsa(c));

    console.log(`📦 [CACHE] Sincronizzazione completata. Totale Veicoli: ${veicoliCache.size}`);
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