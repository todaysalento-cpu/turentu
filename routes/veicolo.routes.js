import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { CacheManager } from '../utils/cacheManager.js';
import fs from 'fs';
import path from 'path';

export const veicoloRouter = express.Router();

// ---------------------------------------------------
// CACHE (Locale per Marche/Modelli)
// ---------------------------------------------------
const cache = {
  marcheModelli: { data: [], lastFetch: 0 }
};
const CACHE_TTL = 1000 * 60 * 60;

// ---------------------------------------------------
// CONFIGURAZIONI E HELPER
// ---------------------------------------------------
export const TIPI_VEICOLO = ['citycar', 'berlina', 'station_wagon', 'suv', 'minivan', 'van', 'luxury', 'electric'];
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const TARGA_REGEX = /^[A-Z]{2}[0-9]{3}[A-Z]{2}$/;

async function geocodeLocalita(localita) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(localita)}&key=${GOOGLE_MAPS_API_KEY}&region=it`;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Errore geocoding');
  const data = await response.json();
  if (!data.results?.length) throw new Error('Località non trovata');
  return { lat: data.results[0].geometry.location.lat, lon: data.results[0].geometry.location.lng };
}

function normalizeInput(body) {
  return {
    marca: body.marca?.trim() || null,
    modello: body.modello?.trim() || null,
    posti_totali: Number(body.posti_totali || 1),
    raggio_km: Number(body.raggio_km || 50),
    targa: body.targa?.trim().toUpperCase() || null,
    servizi: Array.isArray(body.servizi) ? body.servizi : [],
    tipo: body.tipo || null,
    anno: body.anno ? Number(body.anno) : null,
    lat: body.lat != null ? Number(body.lat) : null,
    lon: body.lon != null ? Number(body.lon) : null,
    localita: body.localita || null,
    image_url: body.image_url || null
  };
}

function validateVeicolo(data) {
  if (data.tipo && !TIPI_VEICOLO.includes(data.tipo)) return 'Tipo veicolo non valido';
  if (data.posti_totali < 1 || data.posti_totali > 99) return 'Numero posti non valido';
  if (data.raggio_km < 1 || data.raggio_km > 1000) return 'Raggio km non valido';
  if (data.anno && (data.anno < 1950 || data.anno > new Date().getFullYear() + 1)) return 'Anno non valido';
  if (data.targa && !TARGA_REGEX.test(data.targa)) return 'Formato targa non valido';
  return null;
}

async function buildCoord(lat, lon, localita) {
  if ((lat == null || lon == null) && localita) {
    const geo = await geocodeLocalita(localita);
    lat = geo.lat; lon = geo.lon;
  }
  if (lat == null || lon == null) return { lat: null, lon: null, ewkt: null };
  return { lat, lon, ewkt: `SRID=4326;POINT(${lon} ${lat})` };
}

// ---------------------------------------------------
// ROUTES
// ---------------------------------------------------
veicoloRouter.use(authMiddleware);

veicoloRouter.get('/marche-modelli', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.marcheModelli.data.length && now - cache.marcheModelli.lastFetch < CACHE_TTL) {
      return res.json(cache.marcheModelli.data);
    }
    const localFile = path.resolve('data/marche_modelli.json');
    if (!fs.existsSync(localFile)) return res.status(500).json({ error: 'Dati veicoli non disponibili' });
    const raw = await fs.promises.readFile(localFile, 'utf-8');
    const jsonData = JSON.parse(raw);
    cache.marcheModelli = { data: jsonData, lastFetch: now };
    res.json(jsonData);
  } catch (err) { res.status(500).json({ error: 'Errore caricamento marche-modelli' }); }
});

veicoloRouter.get('/tipi', (req, res) => res.json(TIPI_VEICOLO));

veicoloRouter.get('/check-targa', async (req, res) => {
  try {
    const { targa, id } = req.query;
    if (!targa) return res.status(400).json({ error: 'Targa mancante' });
    let query = 'SELECT id FROM veicolo WHERE targa=$1';
    const params = [targa.trim().toUpperCase()];
    if (id) {
      params.push(Number(id));
      query += ' AND id<>$2';
    }
    const result = await pool.query(query, params);
    res.json({ inUse: result.rowCount > 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

veicoloRouter.get('/', async (req, res) => {
  try {
    const veicoloRes = await pool.query(`SELECT *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat FROM veicolo WHERE driver_id=$1 ORDER BY id DESC`, [req.user.id]);
    const veicoli = veicoloRes.rows;
    const ids = veicoli.map(v => v.id);
    const documentiMap = {};
    if (ids.length) {
      const docRes = await pool.query(`SELECT veicolo_id, tipo, url, stato FROM documenti_autista WHERE veicolo_id = ANY($1::int[])`, [ids]);
      docRes.rows.forEach(d => {
        if (!documentiMap[d.veicolo_id]) documentiMap[d.veicolo_id] = {};
        documentiMap[d.veicolo_id][d.tipo] = { url: d.url, stato: d.stato };
      });
    }
    res.json(veicoli.map(v => ({ ...v, documenti: documentiMap[v.id] || {} })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

veicoloRouter.get('/:id', async (req, res) => {
  try {
    const veicoloRes = await pool.query(`SELECT *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat FROM veicolo WHERE id=$1 AND driver_id=$2`, [req.params.id, req.user.id]);
    if (!veicoloRes.rowCount) return res.status(404).json({ error: 'Veicolo non trovato' });
    const docRes = await pool.query(`SELECT tipo, url, stato FROM documenti_autista WHERE veicolo_id=$1`, [req.params.id]);
    const documenti = {};
    docRes.rows.forEach(d => documenti[d.tipo] = { url: d.url, stato: d.stato });
    res.json({ ...veicoloRes.rows[0], documenti });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

veicoloRouter.post('/', async (req, res) => {
  try {
    const data = normalizeInput(req.body);
    const validationError = validateVeicolo(data);
    if (validationError) return res.status(400).json({ error: validationError });
    const coordData = await buildCoord(data.lat, data.lon, data.localita);
    const result = await pool.query(`
      INSERT INTO veicolo (driver_id, marca, modello, posti_totali, raggio_km, targa, servizi, tipo, anno, coord, localita, image_url)
      VALUES ($1,$2,$3,$4,$5,$6, $7::jsonb, $8,$9, ST_GeomFromEWKT($10), $11, $12)
      RETURNING *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat`,
      [req.user.id, data.marca, data.modello, data.posti_totali, data.raggio_km, data.targa, JSON.stringify(data.servizi), data.tipo, data.anno, coordData.ewkt, data.localita, data.image_url]
    );
    await CacheManager.veicolo.update(result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- PUT AGGIORNATO CON INVALIDAZIONE CACHE ---
veicoloRouter.put('/:id', async (req, res) => {
  try {
    const veicoloId = Number(req.params.id);
    const data = normalizeInput(req.body);
    const validationError = validateVeicolo(data);
    if (validationError) return res.status(400).json({ error: validationError });

    const coordData = await buildCoord(data.lat, data.lon, data.localita);
    const result = await pool.query(`
      UPDATE veicolo SET marca=$1, modello=$2, posti_totali=$3, raggio_km=$4, targa=$5, servizi=$6::jsonb, tipo=$7, anno=$8,
      coord = COALESCE(ST_GeomFromEWKT($9), coord), localita=$10, image_url=$11
      WHERE id=$12 AND driver_id=$13
      RETURNING *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat`,
      [data.marca, data.modello, data.posti_totali, data.raggio_km, data.targa, JSON.stringify(data.servizi), data.tipo, data.anno, coordData.ewkt, data.localita, data.image_url, veicoloId, req.user.id]
    );

    if (!result.rowCount) return res.status(404).json({ error: 'Veicolo non trovato' });

    // 1. Invalidazione forzata per pulire dati obsoleti dalla cache
    await CacheManager.veicolo.delete(veicoloId);
    // 2. Aggiornamento con il nuovo oggetto ritornato dal DB
    await CacheManager.veicolo.update(result.rows[0]);

    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

veicoloRouter.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM veicolo WHERE id=$1 AND driver_id=$2 RETURNING *`, [req.params.id, req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Veicolo non trovato' });
    await CacheManager.veicolo.delete(Number(req.params.id));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});