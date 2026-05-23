// services/veicolo/veicolo.service.js
import { pool } from '../../db/db.js';
import { CacheManager } from '../../utils/cacheManager.js';
import { getVeicoliCache } from '../search/search.cache.js';

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
      [veicoloId, Number(coord.lon), Number(coord.lat), validUntil ? new Date(validUntil) : null]
    );

    if (localClient) await client.query('COMMIT');
  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    console.error(`Errore aggiornando posizione corrente veicolo ${veicoloId}:`, err.message);
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

    // Utilizziamo un approccio di inserimento atomico
    await client.query(
      `INSERT INTO posizione_veicolo (veicolo_id, coord, timestamp, valid_until, tipo)
       SELECT $1, ST_SetSRID(ST_MakePoint($2,$3),4326), $4, $5, 'PREDITTIVA'
       WHERE NOT EXISTS (
         SELECT 1 FROM posizione_veicolo
         WHERE veicolo_id = $1
           AND tipo='PREDITTIVA'
           AND timestamp <= $5
           AND (valid_until IS NULL OR valid_until >= $4)
       )`,
      [veicoloId, Number(coord.lon), Number(coord.lat), fromTime, validUntil]
    );

    if (localClient) await client.query('COMMIT');
  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    console.error(`Errore aggiornando posizione predittiva veicolo ${veicoloId}:`, err.message);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}

// =========================
// Aggiorna posizione CORRENTE + Cache
export async function aggiornaPosizioneVeicoloCache(veicoloId, coord, validUntil, client) {
  await aggiornaPosizioneVeicolo(veicoloId, coord, validUntil, client);

  const v = getVeicoliCache().get(veicoloId);
  if (v) {
    CacheManager.veicolo.update({
      ...v, // Preserva le altre proprietà (es. coordPredittiva esistente)
      coordCorrente: { 
        lat: Number(coord.lat), 
        lon: Number(coord.lon), 
        tipo: 'CORRENTE', 
        timestamp: new Date() 
      }
    });
  }
}

// =========================
// Aggiorna posizione PREDITTIVA + Cache
export async function aggiornaPosizionePredittivaCache(veicoloId, coord, fromTime, tempoX, client) {
  await aggiornaPosizionePredittiva(veicoloId, coord, fromTime, tempoX, client);

  const v = getVeicoliCache().get(veicoloId);
  if (v) {
    CacheManager.veicolo.update({
      ...v, // Preserva le altre proprietà (es. coordCorrente esistente)
      coordPredittiva: {
        lat: Number(coord.lat),
        lon: Number(coord.lon),
        tipo: 'PREDITTIVA',
        validUntil: new Date(new Date(fromTime).getTime() + tempoX),
        timestamp: new Date()
      }
    });
  }
}

// =========================
// Recupera posizione veicolo dalla cache
export function getVeicoloCoordCache(veicoloId, atTime = new Date()) {
  const v = getVeicoliCache().get(veicoloId);
  if (!v) return { lat: 41.8902, lon: 12.4922, tipo: 'FALLBACK' };

  // Verifica validità predittiva
  if (v.coordPredittiva && atTime <= new Date(v.coordPredittiva.validUntil)) {
    return v.coordPredittiva;
  }
  // Fallback a corrente
  if (v.coordCorrente) return v.coordCorrente;
  // Fallback a dati base veicolo
  if (v.lat != null && v.lon != null) return { lat: v.lat, lon: v.lon, tipo: 'BASE' };

  return { lat: 41.8902, lon: 12.4922, tipo: 'FALLBACK' };
}

// =========================
// Recupera coordinate veicoli in batch dalla cache
export function getVeicoliCoordBatchCache(richieste) {
  const map = {};
  const now = new Date();
  for (const r of richieste) {
    map[r.veicolo_id] = getVeicoloCoordCache(r.veicolo_id, r.atTime || now);
  }
  return map;
}