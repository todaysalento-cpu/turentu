import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';

export const veicoloRouter = express.Router();
veicoloRouter.use(authMiddleware);

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
// GET tutti i veicoli dell'autista loggato
// ----------------------------
veicoloRouter.get('/', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const result = await pool.query(
      'SELECT * FROM veicolo WHERE driver_id=$1 ORDER BY id DESC',
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
// ----------------------------
veicoloRouter.post('/', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const { modello, marca, posti_totali, raggio_km, targa, servizi, tipo, anno, lat, lon, image_url } = req.body;

    // Validazione tipo veicolo
    if (tipo && !TIPI_VEICOLO.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo veicolo non valido' });
    }

    const result = await pool.query(
      `INSERT INTO veicolo
        (driver_id, marca, modello, posti_totali, raggio_km, targa, servizi, tipo, anno,
         coord, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               ST_SetSRID(ST_MakePoint($10,$11),4326),
               $12)
       RETURNING *`,
      [
        driver_id, marca, modello, posti_totali, raggio_km || 50, targa || null,
        JSON.stringify(servizi || []), tipo || null, anno || null,
        lon || null, lat || null, image_url || null,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Veicoli POST error:', err);
    if (err.code === '23505' && err.constraint === 'veicolo_targa_key') {
      return res.status(400).json({ error: 'Targa già utilizzata da un altro veicolo' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// PUT aggiorna veicolo
// ----------------------------
veicoloRouter.put('/:id', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const veicolo_id = Number(req.params.id);
    const { modello, marca, posti_totali, raggio_km, targa, servizi, tipo, anno, lat, lon, image_url } = req.body;

    // Validazione tipo veicolo
    if (tipo && !TIPI_VEICOLO.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo veicolo non valido' });
    }

    const result = await pool.query(
      `UPDATE veicolo
       SET marca=$1, modello=$2, posti_totali=$3, raggio_km=$4,
           targa=$5, servizi=$6, tipo=$7, anno=$8,
           coord=ST_SetSRID(ST_MakePoint($9,$10),4326),
           image_url=$11
       WHERE id=$12 AND driver_id=$13
       RETURNING *`,
      [
        marca, modello, posti_totali, raggio_km,
        targa, JSON.stringify(servizi || []), tipo || null, anno || null,
        lon || null, lat || null, image_url || null,
        veicolo_id, driver_id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Veicolo non trovato o non autorizzato' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Veicolo PUT error:', err);
    if (err.code === '23505' && err.constraint === 'veicolo_targa_key') {
      return res.status(400).json({ error: 'Targa già utilizzata da un altro veicolo' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// DELETE veicolo
// ----------------------------
veicoloRouter.delete('/:id', async (req, res) => {
  try {
    const driver_id = req.user.id;
    const veicolo_id = Number(req.params.id);

    const result = await pool.query(
      'DELETE FROM veicolo WHERE id=$1 AND driver_id=$2 RETURNING *',
      [veicolo_id, driver_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Veicolo non trovato o non autorizzato' });
    }

    res.json({ message: 'Veicolo eliminato ✅' });
  } catch (err) {
    console.error('❌ Veicoli DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// GET marche-modelli da JSON locale (stabile)
// ----------------------------
veicoloRouter.get('/marche-modelli', async (req, res) => {
  try {
    const now = Date.now();

    if (cache.marcheModelli.data.length && now - cache.marcheModelli.lastFetch < CACHE_TTL) {
      console.log('⚡ Cache in memoria utilizzata');
      return res.json(cache.marcheModelli.data);
    }

    const localFile = path.resolve('data/marche_modelli.json');

    if (!fs.existsSync(localFile)) {
      console.error('❌ JSON locale marche_modelli.json non trovato');
      return res.status(500).json({ error: 'Dati veicoli non disponibili' });
    }

    const jsonData = JSON.parse(fs.readFileSync(localFile, 'utf-8'));
    cache.marcheModelli = { data: jsonData, lastFetch: now };
    console.log(`📂 Marche e modelli caricati dal JSON locale (${jsonData.length} marche)`);

    res.json(jsonData);
  } catch (err) {
    console.error('❌ Errore caricamento marche-modelli:', err);
    res.status(500).json({ error: 'Impossibile caricare i dati dei veicoli' });
  }
});

// ----------------------------
// GET lista tipi veicolo
// ----------------------------
veicoloRouter.get('/tipi', (req, res) => {
  res.json(TIPI_VEICOLO);
});