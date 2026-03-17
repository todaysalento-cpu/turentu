import ngeohash from 'ngeohash';
import { haversineDistance } from '../../utils/geo.util.js';
import { pool } from '../../db/db.js';

const GEOHASH_PRECISION = 5;

let veicoliCache = null;
let disponibilitaCache = null;
let corseCache = null;
const TOP_RESULTS = 10;

// Helper sicuro per parsing JSON
function safeParseJSON(str, fallback = []) {
  if (!str) return fallback;
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export async function loadCachesUltra() {
  if (veicoliCache && disponibilitaCache && corseCache) return;

  const client = await pool.connect();
  try {
    // -------------------------
    // VEICOLI
    // -------------------------
    const veicoliRes = await client.query(`
      SELECT id, modello, posti_totali, euro_km, prezzo_passeggero, servizi,
             ST_Y(coord::geometry) AS lat,
             ST_X(coord::geometry) AS lon
      FROM veicolo
    `);

    veicoliCache = veicoliRes.rows.reduce((acc, v) => {
      acc[v.id] = {
        ...v,
        geohash: ngeohash.encode(v.lat, v.lon, GEOHASH_PRECISION),
        servizi: Array.isArray(v.servizi) ? v.servizi : safeParseJSON(v.servizi, []),
        prezzo_passeggero: Number(v.prezzo_passeggero ?? 1),
        euro_km: Number(v.euro_km ?? 1),
        posti_totali: Number(v.posti_totali ?? 4)
      };
      return acc;
    }, {});

    // -------------------------
    // DISPONIBILITA
    // -------------------------
    disponibilitaCache = (await client.query(`SELECT * FROM disponibilita_veicolo`)).rows;

    // -------------------------
    // CORSE
    // -------------------------
    corseCache = (await client.query(`
      SELECT c.*, v.euro_km,
             ST_Y(c.origine::geometry) AS origine_lat,
             ST_X(c.origine::geometry) AS origine_lon,
             ST_Y(c.destinazione::geometry) AS dest_lat,
             ST_X(c.destinazione::geometry) AS dest_lon,
             COALESCE(EXTRACT(EPOCH FROM c.durata), 0) AS durata,
             COALESCE(c.posti_prenotati, 0) AS posti_prenotati,
             COALESCE(c.primo_posto, 0) AS primo_posto
      FROM corse c
      JOIN veicolo v ON v.id = c.veicolo_id
      WHERE c.stato = 'prenotabile'
    `)).rows;

    corseCache.forEach(c => {
      c.geohashOrigine = ngeohash.encode(c.origine_lat, c.origine_lon, GEOHASH_PRECISION);
      c.geohashDest = ngeohash.encode(c.dest_lat, c.dest_lon, GEOHASH_PRECISION);
    });

    console.log('✅ Cache iniziale caricata');
  } finally {
    client.release();
  }
}

// Esporta le cache in lettura
export { veicoliCache, disponibilitaCache, corseCache, TOP_RESULTS };
