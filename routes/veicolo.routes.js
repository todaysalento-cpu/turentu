import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';

export const veicoloRouter = express.Router();

// ----------------------------
// Cache in memoria
// ----------------------------
const cache = {
  marcheModelli: { data: [], lastFetch: 0 },
};
const CACHE_TTL = 1000 * 60 * 60; // 1 ora

// ----------------------------
// Tipi veicolo ufficiali
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

// ----------------------------
// 🔹 GET marche-modelli (pubblico, cache + JSON locale)
// ----------------------------
veicoloRouter.get('/marche-modelli', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.marcheModelli.data.length && now - cache.marcheModelli.lastFetch < CACHE_TTL) {
      return res.json(cache.marcheModelli.data);
    }

    const localFile = path.resolve('data/marche_modelli.json');
    if (!fs.existsSync(localFile)) {
      return res.status(500).json({ error: 'Dati veicoli non disponibili' });
    }

    const jsonData = JSON.parse(fs.readFileSync(localFile, 'utf-8'));
    cache.marcheModelli = { data: jsonData, lastFetch: now };
    res.json(jsonData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore caricamento marche-modelli' });
  }
});

// ----------------------------
// Tutte le rotte successive richiedono autenticazione
// ----------------------------
veicoloRouter.use(authMiddleware);

// ----------------------------
// 🔥 GET tutti i veicoli (cast coord::geometry per ST_X/ST_Y)
veicoloRouter.get('/', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const result = await pool.query(
      `SELECT *,
         ST_X(coord::geometry) AS lon,
         ST_Y(coord::geometry) AS lat
       FROM veicolo
       WHERE driver_id=$1
       ORDER BY id DESC`,
      [driver_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Veicoli GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// POST nuovo veicolo
veicoloRouter.post('/', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const { modello, marca, posti_totali, raggio_km, targa, servizi, tipo, anno, lat, lon, image_url } = req.body;

    if (tipo && !TIPI_VEICOLO.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo veicolo non valido' });
    }

    if (targa) {
      const targaCheck = await pool.query('SELECT id FROM veicolo WHERE targa=$1', [targa]);
      if (targaCheck.rowCount > 0) return res.status(400).json({ error: 'Targa già utilizzata' });
    }

    const result = await pool.query(
      `INSERT INTO veicolo
        (driver_id, marca, modello, posti_totali, raggio_km, targa, servizi, tipo, anno,
         coord, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               CASE WHEN $10 IS NOT NULL AND $11 IS NOT NULL THEN ST_SetSRID(ST_MakePoint($10,$11),4326) ELSE NULL END,
               $12)
       RETURNING *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat`,
      [
        driver_id, marca, modello, posti_totali, raggio_km || 50,
        targa || null, JSON.stringify(servizi || []),
        tipo || null, anno || null, lon || null, lat || null, image_url || null
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Veicoli POST error:', err);
    if (err.code === '23505') return res.status(400).json({ error: 'Targa già utilizzata' });
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// PUT veicolo
veicoloRouter.put('/:id', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const veicoloId = parseInt(req.params.id);
    const { modello, marca, posti_totali, raggio_km, targa, servizi, tipo, anno, lat, lon, image_url } = req.body;

    if (tipo && !TIPI_VEICOLO.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo veicolo non valido' });
    }

    if (targa) {
      const targaCheck = await pool.query(
        'SELECT id FROM veicolo WHERE targa=$1 AND id<>$2',
        [targa, veicoloId]
      );
      if (targaCheck.rowCount > 0) return res.status(400).json({ error: 'Targa già utilizzata' });
    }

    const result = await pool.query(
      `UPDATE veicolo SET
        marca=$1, modello=$2, posti_totali=$3, raggio_km=$4, targa=$5, servizi=$6, tipo=$7, anno=$8,
        coord=CASE WHEN $9 IS NOT NULL AND $10 IS NOT NULL THEN ST_SetSRID(ST_MakePoint($9,$10),4326) ELSE coord END,
        image_url=$11
       WHERE id=$12 AND driver_id=$13
       RETURNING *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat`,
      [
        marca, modello, posti_totali, raggio_km || 50,
        targa || null, JSON.stringify(servizi || []),
        tipo || null, anno || null, lon || null, lat || null, image_url || null,
        veicoloId, driver_id
      ]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Veicolo non trovato' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Veicoli PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// DELETE veicolo
veicoloRouter.delete('/:id', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const veicoloId = parseInt(req.params.id);

    const result = await pool.query(
      'DELETE FROM veicolo WHERE id=$1 AND driver_id=$2 RETURNING *',
      [veicoloId, driver_id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Veicolo non trovato' });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Veicoli DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// Check targa duplicata
veicoloRouter.get('/check-targa', async (req, res) => {
  try {
    const { targa, id } = req.query;
    if (!targa) return res.status(400).json({ error: 'Targa mancante' });

    const params = [targa];
    let query = 'SELECT id FROM veicolo WHERE targa=$1';
    if (id) {
      params.push(parseInt(id));
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
// GET tipi veicolo
veicoloRouter.get('/tipi', (req, res) => {
  res.json(TIPI_VEICOLO);
});