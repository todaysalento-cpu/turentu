import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { CacheManager } from '../utils/cacheManager.js';
import fs from 'fs';
import path from 'path';

export const veicoloRouter = express.Router();

// ---------------------------------------------------
// CACHE
// ---------------------------------------------------
const cache = {
  marcheModelli: {
    data: [],
    lastFetch: 0
  }
};

const CACHE_TTL = 1000 * 60 * 60;

// ---------------------------------------------------
// TIPI VEICOLO
// ---------------------------------------------------
export const TIPI_VEICOLO = [
  'citycar',
  'berlina',
  'station_wagon',
  'suv',
  'minivan',
  'van',
  'luxury',
  'electric'
];

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ---------------------------------------------------
// REGEX
// ---------------------------------------------------
const TARGA_REGEX = /^[A-Z]{2}[0-9]{3}[A-Z]{2}$/;

// ---------------------------------------------------
// GEOCODING
// ---------------------------------------------------
async function geocodeLocalita(localita) {
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json?` +
    `address=${encodeURIComponent(localita)}` +
    `&key=${GOOGLE_MAPS_API_KEY}` +
    `&region=it`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('Errore geocoding');
  }

  const data = await response.json();

  if (!data.results?.length) {
    throw new Error('Località non trovata');
  }

  const location = data.results[0].geometry.location;

  return {
    lat: location.lat,
    lon: location.lng
  };
}

// ---------------------------------------------------
// NORMALIZZAZIONE INPUT
// ---------------------------------------------------
function normalizeInput(body) {
  return {
    marca: body.marca?.trim() || null,
    modello: body.modello?.trim() || null,

    posti_totali: Number(body.posti_totali || 1),

    raggio_km: Number(body.raggio_km || 50),

    targa: body.targa?.trim().toUpperCase() || null,

    servizi: Array.isArray(body.servizi)
      ? body.servizi
      : [],

    tipo: body.tipo || null,

    anno: body.anno
      ? Number(body.anno)
      : null,

    lat: body.lat != null
      ? Number(body.lat)
      : null,

    lon: body.lon != null
      ? Number(body.lon)
      : null,

    localita: body.localita || null,

    image_url: body.image_url || null
  };
}

// ---------------------------------------------------
// VALIDAZIONE
// ---------------------------------------------------
function validateVeicolo(data) {

  if (data.tipo && !TIPI_VEICOLO.includes(data.tipo)) {
    return 'Tipo veicolo non valido';
  }

  if (data.posti_totali < 1 || data.posti_totali > 99) {
    return 'Numero posti non valido';
  }

  if (data.raggio_km < 1 || data.raggio_km > 1000) {
    return 'Raggio km non valido';
  }

  if (
    data.anno &&
    (
      data.anno < 1950 ||
      data.anno > new Date().getFullYear() + 1
    )
  ) {
    return 'Anno non valido';
  }

  if (data.targa && !TARGA_REGEX.test(data.targa)) {
    return 'Formato targa non valido';
  }

  return null;
}

// ---------------------------------------------------
// BUILD COORD
// ---------------------------------------------------
async function buildCoord(lat, lon, localita) {

  if ((lat == null || lon == null) && localita) {

    const geo = await geocodeLocalita(localita);

    lat = geo.lat;
    lon = geo.lon;
  }

  if (lat == null || lon == null) {
    return {
      lat: null,
      lon: null,
      ewkt: null
    };
  }

  return {
    lat,
    lon,
    ewkt: `SRID=4326;POINT(${lon} ${lat})`
  };
}

// ---------------------------------------------------
// AUTH
// ---------------------------------------------------
veicoloRouter.use(authMiddleware);

// ---------------------------------------------------
// GET MARCHE MODELLI
// ---------------------------------------------------
veicoloRouter.get('/marche-modelli', async (req, res) => {

  try {

    const now = Date.now();

    if (
      cache.marcheModelli.data.length &&
      now - cache.marcheModelli.lastFetch < CACHE_TTL
    ) {
      return res.json(cache.marcheModelli.data);
    }

    const localFile = path.resolve('data/marche_modelli.json');

    if (!fs.existsSync(localFile)) {
      return res.status(500).json({
        error: 'Dati veicoli non disponibili'
      });
    }

    const raw = await fs.promises.readFile(localFile, 'utf-8');

    const jsonData = JSON.parse(raw);

    cache.marcheModelli = {
      data: jsonData,
      lastFetch: now
    };

    res.json(jsonData);

  } catch (err) {

    console.error('❌ Marche/modelli error:', err);

    res.status(500).json({
      error: 'Errore caricamento marche-modelli'
    });
  }
});

// ---------------------------------------------------
// GET TIPI
// ---------------------------------------------------
veicoloRouter.get('/tipi', (req, res) => {
  res.json(TIPI_VEICOLO);
});

// ---------------------------------------------------
// CHECK TARGA
// ---------------------------------------------------
veicoloRouter.get('/check-targa', async (req, res) => {

  try {

    const { targa, id } = req.query;

    if (!targa) {
      return res.status(400).json({
        error: 'Targa mancante'
      });
    }

    const cleanTarga = targa.trim().toUpperCase();

    const params = [cleanTarga];

    let query =
      'SELECT id FROM veicolo WHERE targa=$1';

    if (id) {

      const veicoloId = Number(
        Array.isArray(id)
          ? id[0]
          : id
      );

      if (Number.isNaN(veicoloId)) {
        return res.status(400).json({
          error: 'ID veicolo non valido'
        });
      }

      params.push(veicoloId);

      query += ' AND id<>$2';
    }

    const result = await pool.query(query, params);

    res.json({
      inUse: result.rowCount > 0
    });

  } catch (err) {

    console.error('❌ Check targa error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});

// ---------------------------------------------------
// GET TUTTI VEICOLI
// ---------------------------------------------------
veicoloRouter.get('/', async (req, res) => {

  try {

    const driver_id = req.user.id;

    const veicoloRes = await pool.query(
      `
      SELECT
        *,
        CASE
          WHEN coord IS NOT NULL
          THEN ST_X(coord::geometry)
        END AS lon,

        CASE
          WHEN coord IS NOT NULL
          THEN ST_Y(coord::geometry)
        END AS lat

      FROM veicolo
      WHERE driver_id=$1
      ORDER BY id DESC
      `,
      [driver_id]
    );

    const veicoli = veicoloRes.rows;

    const ids = veicoli.map(v => v.id);

    const documentiMap = {};

    if (ids.length) {

      const docRes = await pool.query(
        `
        SELECT
          veicolo_id,
          tipo,
          url,
          stato
        FROM documenti_autista
        WHERE veicolo_id = ANY($1::int[])
        `,
        [ids]
      );

      for (const d of docRes.rows) {

        if (!documentiMap[d.veicolo_id]) {
          documentiMap[d.veicolo_id] = {};
        }

        documentiMap[d.veicolo_id][d.tipo] = {
          url: d.url,
          stato: d.stato
        };
      }
    }

    const result = veicoli.map(v => ({
      ...v,
      documenti: documentiMap[v.id] || {}
    }));

    res.json(result);

  } catch (err) {

    console.error('❌ Veicoli GET error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});

// ---------------------------------------------------
// GET SINGOLO VEICOLO
// ---------------------------------------------------
veicoloRouter.get('/:id', async (req, res) => {

  try {

    const driver_id = req.user.id;

    const veicoloId = Number(req.params.id);

    if (!veicoloId) {
      return res.status(400).json({
        error: 'ID veicolo non valido'
      });
    }

    const veicoloRes = await pool.query(
      `
      SELECT
        *,
        CASE
          WHEN coord IS NOT NULL
          THEN ST_X(coord::geometry)
        END AS lon,

        CASE
          WHEN coord IS NOT NULL
          THEN ST_Y(coord::geometry)
        END AS lat

      FROM veicolo
      WHERE id=$1
      AND driver_id=$2
      `,
      [veicoloId, driver_id]
    );

    if (!veicoloRes.rowCount) {
      return res.status(404).json({
        error: 'Veicolo non trovato'
      });
    }

    const veicolo = veicoloRes.rows[0];

    const docRes = await pool.query(
      `
      SELECT
        tipo,
        url,
        stato
      FROM documenti_autista
      WHERE veicolo_id=$1
      `,
      [veicoloId]
    );

    const documenti = {};

    for (const d of docRes.rows) {

      documenti[d.tipo] = {
        url: d.url,
        stato: d.stato
      };
    }

    res.json({
      ...veicolo,
      documenti
    });

  } catch (err) {

    console.error('❌ Veicolo GET/:id error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});

// ---------------------------------------------------
// POST VEICOLO
// ---------------------------------------------------
veicoloRouter.post('/', async (req, res) => {

  try {

    const driver_id = req.user.id;

    const data = normalizeInput(req.body);

    const validationError = validateVeicolo(data);

    if (validationError) {
      return res.status(400).json({
        error: validationError
      });
    }

    // CHECK TARGA
    if (data.targa) {

      const check = await pool.query(
        'SELECT id FROM veicolo WHERE targa=$1',
        [data.targa]
      );

      if (check.rowCount > 0) {
        return res.status(400).json({
          error: 'Targa già utilizzata'
        });
      }
    }

    // COORD
    const coordData = await buildCoord(
      data.lat,
      data.lon,
      data.localita
    );

    const result = await pool.query(
      `
      INSERT INTO veicolo (
        driver_id,
        marca,
        modello,
        posti_totali,
        raggio_km,
        targa,
        servizi,
        tipo,
        anno,
        coord,
        localita,
        image_url
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,
        $7::jsonb,
        $8,$9,
        ST_GeomFromEWKT($10),
        $11,$12
      )

      RETURNING
        *,
        CASE
          WHEN coord IS NOT NULL
          THEN ST_X(coord::geometry)
        END AS lon,

        CASE
          WHEN coord IS NOT NULL
          THEN ST_Y(coord::geometry)
        END AS lat
      `,
      [
        driver_id,
        data.marca,
        data.modello,
        data.posti_totali,
        data.raggio_km,
        data.targa,
        JSON.stringify(data.servizi),
        data.tipo,
        data.anno,
        coordData.ewkt,
        data.localita,
        data.image_url
      ]
    );

    const veicolo = result.rows[0];

    // CACHE
    await CacheManager.veicolo.update(veicolo);

    res.json(veicolo);

  } catch (err) {

    console.error('❌ Veicoli POST error:', err);

    if (err.code === '23505') {
      return res.status(400).json({
        error: 'Targa già utilizzata'
      });
    }

    res.status(500).json({
      error: err.message
    });
  }
});

// ---------------------------------------------------
// PUT VEICOLO
// ---------------------------------------------------
veicoloRouter.put('/:id', async (req, res) => {

  try {

    const driver_id = req.user.id;

    const veicoloId = Number(req.params.id);

    if (!veicoloId) {
      return res.status(400).json({
        error: 'ID veicolo non valido'
      });
    }

    const data = normalizeInput(req.body);

    const validationError = validateVeicolo(data);

    if (validationError) {
      return res.status(400).json({
        error: validationError
      });
    }

    // CHECK TARGA
    if (data.targa) {

      const check = await pool.query(
        `
        SELECT id
        FROM veicolo
        WHERE targa=$1
        AND id<>$2
        `,
        [data.targa, veicoloId]
      );

      if (check.rowCount > 0) {
        return res.status(400).json({
          error: 'Targa già utilizzata'
        });
      }
    }

    // COORD
    const coordData = await buildCoord(
      data.lat,
      data.lon,
      data.localita
    );

    const result = await pool.query(
      `
      UPDATE veicolo SET

        marca=$1,
        modello=$2,
        posti_totali=$3,
        raggio_km=$4,
        targa=$5,
        servizi=$6::jsonb,
        tipo=$7,
        anno=$8,

        coord = COALESCE(
          ST_GeomFromEWKT($9),
          coord
        ),

        localita=$10,
        image_url=$11

      WHERE id=$12
      AND driver_id=$13

      RETURNING
        *,
        CASE
          WHEN coord IS NOT NULL
          THEN ST_X(coord::geometry)
        END AS lon,

        CASE
          WHEN coord IS NOT NULL
          THEN ST_Y(coord::geometry)
        END AS lat
      `,
      [
        data.marca,
        data.modello,
        data.posti_totali,
        data.raggio_km,
        data.targa,
        JSON.stringify(data.servizi),
        data.tipo,
        data.anno,
        coordData.ewkt,
        data.localita,
        data.image_url,
        veicoloId,
        driver_id
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: 'Veicolo non trovato'
      });
    }

    const veicolo = result.rows[0];

    // CACHE
    await CacheManager.veicolo.update(veicolo);

    res.json(veicolo);

  } catch (err) {

    console.error('❌ Veicoli PUT error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});

// ---------------------------------------------------
// DELETE VEICOLO
// ---------------------------------------------------
veicoloRouter.delete('/:id', async (req, res) => {

  try {

    const driver_id = req.user.id;

    const veicoloId = Number(req.params.id);

    if (!veicoloId) {
      return res.status(400).json({
        error: 'ID veicolo non valido'
      });
    }

    const result = await pool.query(
      `
      DELETE FROM veicolo
      WHERE id=$1
      AND driver_id=$2
      RETURNING *
      `,
      [veicoloId, driver_id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: 'Veicolo non trovato'
      });
    }

    // CACHE
    await CacheManager.veicolo.delete(veicoloId);

    res.json({
      success: true
    });

  } catch (err) {

    console.error('❌ Veicoli DELETE error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});