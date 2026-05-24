import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

export const veicoloRouter = express.Router();

// ----------------------------
// Cache
// ----------------------------
const cache = { marcheModelli: { data: [], lastFetch: 0 } };
const CACHE_TTL = 1000 * 60 * 60;

// ----------------------------
// Tipi veicolo
// ----------------------------
export const TIPI_VEICOLO = [
  "citycar",
  "berlina",
  "station_wagon",
  "suv",
  "minivan",
  "van",
  "luxury",
  "electric"
];

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ----------------------------
// Funzione geocode backend
// ----------------------------
async function geocodeLocalita(localita) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(localita)}&key=${GOOGLE_MAPS_API_KEY}&region=it`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Errore geocoding');
  const data = await res.json();
  if (!data.results?.length) throw new Error('Località non trovata');
  const location = data.results[0].geometry.location;
  return { lat: location.lat, lon: location.lng };
}

// ----------------------------
// AUTENTICAZIONE
// ----------------------------
veicoloRouter.use(authMiddleware);

// ----------------------------
// ROUTE STATICHE
// ----------------------------

// GET marche-modelli
veicoloRouter.get('/marche-modelli', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.marcheModelli.data.length && now - cache.marcheModelli.lastFetch < CACHE_TTL) {
      return res.json(cache.marcheModelli.data);
    }

    const localFile = path.resolve('data/marche_modelli.json');
    if (!fs.existsSync(localFile)) return res.status(500).json({ error: 'Dati veicoli non disponibili' });

    const jsonData = JSON.parse(fs.readFileSync(localFile, 'utf-8'));
    cache.marcheModelli = { data: jsonData, lastFetch: now };
    res.json(jsonData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore caricamento marche-modelli' });
  }
});

// GET tipi veicolo
veicoloRouter.get('/tipi', (req, res) => res.json(TIPI_VEICOLO));

// CHECK targa
veicoloRouter.get('/check-targa', async (req, res) => {
  try {
    const { targa, id } = req.query;
    if (!targa) return res.status(400).json({ error: 'Targa mancante' });

    const params = [targa];
    let query = 'SELECT id FROM veicolo WHERE targa=$1';

    if (id) {
      const idNum = Number(Array.isArray(id) ? id[0] : id);
      if (Number.isNaN(idNum)) return res.status(400).json({ error: 'ID veicolo non valido' });
      params.push(idNum);
      query += ' AND id<>$2';
    }

    const result = await pool.query(query, params);
    res.json({ inUse: result.rowCount > 0 });
  } catch (err) {
    console.error('❌ Check targa error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// ROUTE DINAMICHE
// ----------------------------

// GET tutti i veicoli con documenti
veicoloRouter.get('/', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const veicoloRes = await pool.query(
      `SELECT *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat
       FROM veicolo
       WHERE driver_id=$1
       ORDER BY id DESC`,
      [driver_id]
    );
    const veicoli = veicoloRes.rows;

    // Recupero documenti
    const veicoloIds = veicoli.map(v => v.id);
    const documentiMap = {};
    if (veicoloIds.length) {
      const docRes = await pool.query(
        `SELECT veicolo_id, tipo, url, stato
         FROM documenti_autista
         WHERE veicolo_id = ANY($1::int[])`,
        [veicoloIds]
      );
      docRes.rows.forEach(d => {
        if (!documentiMap[d.veicolo_id]) documentiMap[d.veicolo_id] = {};
        documentiMap[d.veicolo_id][d.tipo] = { url: d.url, stato: d.stato };
      });
    }

    const veicoliWithDocs = veicoli.map(v => ({
      ...v,
      documenti: documentiMap[v.id] || {}
    }));

    res.json(veicoliWithDocs);
  } catch (err) {
    console.error('❌ Veicoli GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET singolo veicolo con documenti
veicoloRouter.get('/:id', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const veicoloId = Number(req.params.id);
    if (!veicoloId) return res.status(400).json({ error: 'ID veicolo non valido' });

    const veicoloRes = await pool.query(
      `SELECT *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat
       FROM veicolo
       WHERE id=$1 AND driver_id=$2`,
      [veicoloId, driver_id]
    );
    if (!veicoloRes.rowCount) return res.status(404).json({ error: 'Veicolo non trovato' });

    const veicolo = veicoloRes.rows[0];

    const docRes = await pool.query(
      `SELECT tipo, url, stato
       FROM documenti_autista
       WHERE veicolo_id=$1`,
      [veicoloId]
    );

    const documenti = {};
    docRes.rows.forEach(d => documenti[d.tipo] = { url: d.url, stato: d.stato });

    res.json({
      ...veicolo,
      documenti
    });
  } catch (err) {
    console.error('❌ Veicolo GET/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST veicolo
veicoloRouter.post('/', async (req, res) => {
  try {
    const driver_id = req.user.id;
    let { modello, marca, posti_totali, raggio_km, targa, servizi, tipo, anno, lat, lon, localita, image_url } = req.body;

    targa = targa?.trim().toUpperCase() || null;
    servizi = servizi ?? [];
    raggio_km = raggio_km ?? 50;

    if (tipo && !TIPI_VEICOLO.includes(tipo))
      return res.status(400).json({ error: 'Tipo veicolo non valido' });

    if (targa) {
      const check = await pool.query('SELECT id FROM veicolo WHERE targa=$1', [targa]);
      if (check.rowCount > 0) return res.status(400).json({ error: 'Targa già utilizzata' });
    }

    if ((!lat || !lon) && localita) {
      const geo = await geocodeLocalita(localita);
      lat = geo.lat;
      lon = geo.lon;
    }

    const coord = lat != null && lon != null ? `SRID=4326;POINT(${lon} ${lat})` : null;

    const result = await pool.query(
      `INSERT INTO veicolo
        (driver_id, marca, modello, posti_totali, raggio_km, targa, servizi, tipo, anno, coord, localita, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,ST_GeomFromText($10),$11,$12)
       RETURNING *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat`,
      [driver_id, marca, modello, posti_totali || 1, raggio_km, targa, JSON.stringify(servizi), tipo ?? null, anno ?? null, coord, localita ?? null, image_url ?? null]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Veicoli POST error:', err);
    if (err.code === '23505') return res.status(400).json({ error: 'Targa già utilizzata' });
    res.status(500).json({ error: err.message });
  }
});

// PUT veicolo
veicoloRouter.put('/:id', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const veicoloId = Number(req.params.id);
    if (!veicoloId) return res.status(400).json({ error: 'ID veicolo non valido' });

    let { modello, marca, posti_totali, raggio_km, targa, servizi, tipo, anno, lat, lon, localita, image_url } = req.body;

    targa = targa?.trim().toUpperCase() || null;
    servizi = servizi ?? [];
    raggio_km = raggio_km ?? 50;

    if (tipo && !TIPI_VEICOLO.includes(tipo))
      return res.status(400).json({ error: 'Tipo veicolo non valido' });

    if (targa) {
      const check = await pool.query('SELECT id FROM veicolo WHERE targa=$1 AND id<>$2', [targa, veicoloId]);
      if (check.rowCount > 0) return res.status(400).json({ error: 'Targa già utilizzata' });
    }

    if ((!lat || !lon) && localita) {
      const geo = await geocodeLocalita(localita);
      lat = geo.lat;
      lon = geo.lon;
    }

    const coord = lat != null && lon != null ? `SRID=4326;POINT(${lon} ${lat})` : null;

    const result = await pool.query(
      `UPDATE veicolo SET
        marca=$1,
        modello=$2,
        posti_totali=$3,
        raggio_km=$4,
        targa=$5,
        servizi=$6::jsonb,
        tipo=$7,
        anno=$8,
        coord = COALESCE(ST_GeomFromText($9), coord),
        localita=$10,
        image_url=$11
       WHERE id=$12 AND driver_id=$13
       RETURNING *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat`,
      [marca, modello, posti_totali || 1, raggio_km, targa, JSON.stringify(servizi), tipo ?? null, anno ?? null, coord, localita ?? null, image_url ?? null, veicoloId, driver_id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Veicolo non trovato' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Veicoli PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE veicolo
veicoloRouter.delete('/:id', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const veicoloId = Number(req.params.id);
    if (!veicoloId) return res.status(400).json({ error: 'ID veicolo non valido' });

    const result = await pool.query('DELETE FROM veicolo WHERE id=$1 AND driver_id=$2 RETURNING *', [veicoloId, driver_id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Veicolo non trovato' });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Veicoli DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});