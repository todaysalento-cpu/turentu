import ngeohash from 'ngeohash';
import { pool } from '../../db/db.js';

const GEOHASH_PRECISION = 5;
const TOP_RESULTS = 10;

let veicoliCache = null;
let disponibilitaCache = null;
let corseCache = null;

// ---------------------------
// GETTER SICURI PER LA CACHE
// ---------------------------
export const getVeicoliCache = () => veicoliCache;
export const getDisponibilitaCache = () => disponibilitaCache;
export const getCorseCache = () => corseCache;

// Funzione helper per parsare JSON sicuro
const safeParseJSON = (str) => {
  try {
    return JSON.parse(str);
  } catch {
    return [];
  }
};

// ---------------------------
// CARICAMENTO CACHE ULTRA
// ---------------------------
export async function loadCachesUltra() {
  if (veicoliCache && disponibilitaCache && corseCache) return;

  const client = await pool.connect();
  try {
    // ---------------------------
    // VEICOLI
    // ---------------------------
    const veicoliRes = await client.query(`
      SELECT id, modello, posti_totali, servizi,
             ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon 
      FROM veicolo
    `);

    veicoliCache = veicoliRes.rows.reduce((acc, v) => {
      acc[v.id] = {
        ...v,
        geohash: ngeohash.encode(v.lat, v.lon, GEOHASH_PRECISION),
        servizi: Array.isArray(v.servizi) ? v.servizi : (v.servizi ? safeParseJSON(v.servizi) : [])
        // rimosse euro_km e prezzo_passeggero
      };
      return acc;
    }, {});

    // ---------------------------
    // DISPONIBILITÀ
    // ---------------------------
    disponibilitaCache = (await client.query(`SELECT * FROM disponibilita_veicolo`)).rows;

    // ---------------------------
    // CORSE ATTIVE
    // ---------------------------
    corseCache = (await client.query(`
      SELECT c.*,
             ST_Y(c.origine::geometry) AS origine_lat,
             ST_X(c.origine::geometry) AS origine_lon,
             ST_Y(c.destinazione::geometry) AS dest_lat,
             ST_X(c.destinazione::geometry) AS dest_lon,
             COALESCE(EXTRACT(EPOCH FROM c.durata), 0) AS durata,
             COALESCE(c.posti_prenotati, 0) AS posti_prenotati,
             COALESCE(c.primo_posto, 0) AS primo_posto
      FROM corse c
      WHERE c.stato = 'prenotabile'
    `)).rows;
    corseCache.forEach(c => {
      c.geohashOrigine = ngeohash.encode(c.origine_lat, c.origine_lon, GEOHASH_PRECISION);
      c.geohashDest = ngeohash.encode(c.dest_lat, c.dest_lon, GEOHASH_PRECISION);
    });

    // 👇👇👇 LOG DI VERIFICA CACHE
    console.log('📦 VEICOLI CACHE:', Object.keys(veicoliCache).length);
    console.log('📦 DISPONIBILITA CACHE:', disponibilitaCache.length);
    console.log('📦 CORSE CACHE:', corseCache.length);
    console.log('📦 CORSE ESEMPIO:', corseCache[0]);


  } finally {
    client.release();
  }
}


// ---------------------------
// UTILI PER FILTRI / DASHBOARD
// ---------------------------

/**
 * Filtra corse per veicolo o cliente
 * @param {Object} params
 * @param {number} [params.veicoloId] - facoltativo
 * @param {number} [params.clienteId] - facoltativo
 * @returns {Array} corse filtrate
 */
export function filterCorse({ veicoloId, clienteId }) {
  let result = [...(corseCache || [])];
  if (veicoloId) result = result.filter(c => c.veicolo_id === veicoloId);
  if (clienteId) result = result.filter(c => c.cliente_id === clienteId);
  return result.slice(0, TOP_RESULTS);
}

export { TOP_RESULTS };
