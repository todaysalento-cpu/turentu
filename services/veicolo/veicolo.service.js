import { pool } from '../../db/db.js';
import { CacheManager } from '../../utils/cacheManager.js';
import { CacheStore, upsertVeicolo } from '../search/search.cache.js'; 

const logger = {
  info: (msg, id) => console.log(`[VeicoloService] INFO [ID:${id || 'SYSTEM'}] ${msg}`),
  error: (msg, id, err) => console.error(`[VeicoloService] ERROR [ID:${id || 'SYSTEM'}] ${msg}`, err?.message || err)
};

const getVeicoliMap = () => CacheStore.veicoliCache;

// =========================
// Aggiorna posizione CORRENTE (DB)
export async function aggiornaPosizioneVeicolo(veicoloId, coord, validUntil, client) {
  if (!coord || coord.lat == null || coord.lon == null) throw new Error('Coordinate non valide');

  let localClient = false;
  if (!client) { client = await pool.connect(); localClient = true; }

  try {
    if (localClient) await client.query('BEGIN');

    await client.query(
      `INSERT INTO posizione_veicolo (veicolo_id, coord, timestamp, valid_until, tipo)
       VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), NOW(), $4, 'CORRENTE')`,
      [veicoloId, coord.lon, coord.lat, validUntil ? new Date(validUntil) : null]
    );

    if (localClient) await client.query('COMMIT');
    logger.info(`Posizione corrente salvata su DB`, veicoloId);
  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    logger.error(`Fallimento persistenza posizione corrente`, veicoloId, err);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}

// =========================
// Aggiorna posizione PREDITTIVA (DB)
export async function aggiornaPosizionePredittiva(veicoloId, coord, fromTime, tempoX, client) {
  if (!coord || coord.lat == null || coord.lon == null) throw new Error('Coordinate non valide');

  let localClient = false;
  if (!client) { client = await pool.connect(); localClient = true; }

  const validUntil = new Date(new Date(fromTime).getTime() + tempoX);

  try {
    if (localClient) await client.query('BEGIN');

    const res = await client.query(
      `INSERT INTO posizione_veicolo (veicolo_id, coord, timestamp, valid_until, tipo)
       SELECT $1, ST_SetSRID(ST_MakePoint($2,$3),4326), $4, $5, 'PREDITTIVA'
       WHERE NOT EXISTS (
           SELECT 1 FROM posizione_veicolo
           WHERE veicolo_id = $1
            AND tipo='PREDITTIVA'
            AND timestamp <= $5
            AND (valid_until IS NULL OR valid_until >= $4)
       )`,
      [veicoloId, coord.lon, coord.lat, fromTime, validUntil]
    );

    if (localClient) await client.query('COMMIT');
    if (res.rowCount > 0) logger.info(`Posizione predittiva salvata su DB`, veicoloId);
  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    logger.error(`Fallimento persistenza posizione predittiva`, veicoloId, err);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}

// =========================
// Aggiorna posizione CORRENTE + Cache
export async function aggiornaPosizioneVeicoloCache(veicoloId, coord, validUntil, client) {
  logger.info(`Inizio aggiornamento CORRENTE`, veicoloId);
  await aggiornaPosizioneVeicolo(veicoloId, coord, validUntil, client);

  const v = getVeicoliMap().get(Number(veicoloId));
  if (v) {
    const updatedVeicolo = {
      ...v, 
      lat: coord.lat,
      lon: coord.lon,
      coordCorrente: { lat: coord.lat, lon: coord.lon, tipo: 'CORRENTE', timestamp: new Date() }
    };

    try {
      await CacheManager.veicolo.update(updatedVeicolo);
      upsertVeicolo(updatedVeicolo);
      logger.info(`Cache aggiornata correttamente`, veicoloId);
    } catch (cacheErr) {
      logger.error(`Errore durante aggiornamento cache`, veicoloId, cacheErr);
    }
  } else {
    logger.info(`Veicolo ID ${veicoloId} non trovato in memoria, skipping cache sync`, veicoloId);
  }
}

// =========================
// Aggiorna posizione PREDITTIVA + Cache
export async function aggiornaPosizionePredittivaCache(veicoloId, coord, fromTime, tempoX, client) {
  logger.info(`Inizio aggiornamento PREDITTIVO`, veicoloId);
  await aggiornaPosizionePredittiva(veicoloId, coord, fromTime, tempoX, client);

  const v = getVeicoliMap().get(Number(veicoloId));
  if (v) {
    const updatedVeicolo = {
      ...v, 
      lat: coord.lat,
      lon: coord.lon,
      coordPredittiva: {
        lat: coord.lat,
        lon: coord.lon,
        tipo: 'PREDITTIVA',
        validUntil: new Date(new Date(fromTime).getTime() + tempoX),
        timestamp: new Date()
      }
    };

    try {
      await CacheManager.veicolo.update(updatedVeicolo);
      upsertVeicolo(updatedVeicolo);
      logger.info(`Cache predittiva aggiornata`, veicoloId);
    } catch (cacheErr) {
      logger.error(`Errore durante aggiornamento cache predittiva`, veicoloId, cacheErr);
    }
  }
}

// =========================
// Recupera posizione con validazione
export function getVeicoloCoordCache(veicoloId, atTime = new Date()) {
  const v = getVeicoliMap().get(Number(veicoloId));
  
  if (!v) {
      logger.info(`Veicolo non in cache, fallback posizione`, veicoloId);
      return { lat: 41.8902, lon: 12.4922, tipo: 'FALLBACK' };
  }

  // Logica priorità
  if (v.coordPredittiva && atTime <= new Date(v.coordPredittiva.validUntil)) {
    return v.coordPredittiva;
  }
  if (v.coordCorrente) return v.coordCorrente;
  if (v.lat != null && v.lon != null) return { lat: v.lat, lon: v.lon, tipo: 'BASE' };

  return { lat: 41.8902, lon: 12.4922, tipo: 'FALLBACK' };
}

export function getVeicoliCoordBatchCache(richieste) {
  const map = {};
  const now = new Date();
  
  try {
    for (const r of richieste) {
      map[r.veicolo_id] = getVeicoloCoordCache(r.veicolo_id, r.atTime || now);
    }
    logger.info(`Batch coordinata elaborato: ${richieste.length} richieste`, 'BATCH');
  } catch (err) {
    logger.error(`Errore critico durante elaborazione batch`, 'BATCH', err);
  }
  return map;
}