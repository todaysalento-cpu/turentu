import { pool } from '../../db/db.js';


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
      [veicoloId, coord.lon, coord.lat, fromTime, validUntil]
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
// Aggiorna posizione CORRENTE + cache
export async function aggiornaPosizioneVeicoloCache(veicoloId, coord, validUntil, client) {
  await aggiornaPosizioneVeicolo(veicoloId, coord, validUntil, client);

  const v = veicoliCache?.[veicoloId];
  if (v) {
    v.coordCorrente = { lat: coord.lat, lon: coord.lon, tipo: 'CORRENTE', timestamp: new Date() };
  }
}

// =========================
// Aggiorna posizione PREDITTIVA + cache
export async function aggiornaPosizionePredittivaCache(veicoloId, coord, fromTime, tempoX, client) {
  await aggiornaPosizionePredittiva(veicoloId, coord, fromTime, tempoX, client);

  const v = veicoliCache?.[veicoloId];
  if (v) {
    v.coordPredittiva = {
      lat: coord.lat,
      lon: coord.lon,
      tipo: 'PREDITTIVA',
      validUntil: new Date(new Date(fromTime).getTime() + tempoX),
      timestamp: new Date()
    };
  }
}

// =========================
// Recupera posizione veicolo dalla cache (PREDITTIVA > CORRENTE > BASE > FALLBACK)
export function getVeicoloCoordCache(veicoloId, atTime = new Date()) {
  const v = veicoliCache?.[veicoloId];
  if (!v) return { lat: 41.8902, lon: 12.4922, tipo: 'FALLBACK' };

  if (v.coordPredittiva && atTime <= new Date(v.coordPredittiva.validUntil)) return v.coordPredittiva;
  if (v.coordCorrente) return v.coordCorrente;
  if (v.lat != null && v.lon != null) return { lat: v.lat, lon: v.lon, tipo: 'BASE' };

  return { lat: 41.8902, lon: 12.4922, tipo: 'FALLBACK' };
}

// =========================
// Recupera coordinate veicoli in batch dalla cache
export function getVeicoliCoordBatchCache(richieste) {
  const map = {};
  for (const r of richieste) {
    map[r.veicolo_id] = getVeicoloCoordCache(r.veicolo_id, r.atTime || new Date());
  }
  return map;
}
