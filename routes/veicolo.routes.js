import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import multer from 'multer';

export const veicoloRouter = express.Router();
const upload = multer(); // Gestione in memoria

// ---------------------------------------------------
// DEBUG MIDDLEWARE
// ---------------------------------------------------
veicoloRouter.use((req, res, next) => {
    console.log(`[DEBUG_ROUTER] ${req.method} ${req.originalUrl}`);
    next();
});

// ---------------------------------------------------
// CONFIG
// ---------------------------------------------------
export const TIPI_VEICOLO = [
    'citycar', 'berlina', 'station_wagon',
    'suv', 'minivan', 'van', 'luxury', 'electric'
];

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const log = (msg, id = 'SYSTEM') =>
    console.log(`[VeicoloRouter] [${id}] ${new Date().toISOString()} - ${msg}`);

// ---------------------------------------------------
// NORMALIZE INPUT
// ---------------------------------------------------
function normalizeInput(body) {
    return {
        marca: body.marca?.trim() || null,
        modello: body.modello?.trim() || null,
        posti_totali: Number(body.posti_totali || 1),
        raggio_km: Number(body.raggio_km || 50),
        targa: body.targa?.trim().toUpperCase() || null,
        servizi: body.servizi ? (typeof body.servizi === 'string' ? JSON.parse(body.servizi) : body.servizi) : [],
        tipo: body.tipo || null,
        anno: body.anno ? Number(body.anno) : null,
        lat: body.lat != null ? Number(body.lat) : null,
        lon: body.lon != null ? Number(body.lon) : null,
        localita: body.localita || null,
        image_url: body.image_url || null
    };
}

// ---------------------------------------------------
// COORD BUILDER
// ---------------------------------------------------
async function buildCoord(lat, lon, localita) {
    if ((lat == null || lon == null) && localita) {
        try {
            const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(localita)}&key=${GOOGLE_MAPS_API_KEY}&region=it`;
            const response = await fetch(url);
            const data = await response.json();

            if (data.results?.length) {
                const g = data.results[0].geometry.location;
                return { lat: g.lat, lon: g.lng, ewkt: `SRID=4326;POINT(${g.lng} ${g.lat})` };
            }
        } catch (e) {
            log(`Geocoding error: ${e.message}`);
        }
    }
    return { lat, lon, ewkt: lat && lon ? `SRID=4326;POINT(${lon} ${lat})` : null };
}

// ---------------------------------------------------
// PUBLIC ROUTES
// ---------------------------------------------------
veicoloRouter.get('/marche-modelli', async (req, res) => {
    try {
        const file = path.join(process.cwd(), 'data', 'marche_modelli.json');
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'File non trovato' });
        const raw = fs.readFileSync(file, 'utf-8');
        res.json(JSON.parse(raw));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

veicoloRouter.get('/tipi', (req, res) => res.json(TIPI_VEICOLO));

veicoloRouter.get('/check-targa', async (req, res) => {
    try {
        const { targa, id } = req.query;
        const query = id ? 'SELECT COUNT(*) FROM veicolo WHERE targa=$1 AND id!=$2' : 'SELECT COUNT(*) FROM veicolo WHERE targa=$1';
        const params = id ? [targa.toUpperCase(), id] : [targa.toUpperCase()];
        const result = await pool.query(query, params);
        res.json({ inUse: parseInt(result.rows[0].count) > 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------
// AUTH MIDDLEWARE
// ---------------------------------------------------
veicoloRouter.use(authMiddleware);

// ---------------------------------------------------
// GET VEICOLI
// ---------------------------------------------------
veicoloRouter.get('/', async (req, res) => {
    try {
        const veicoli = await pool.query(`SELECT *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat FROM veicolo WHERE driver_id=$1 ORDER BY id DESC`, [req.user.id]);
        res.json(veicoli.rows.map(v => ({ ...v, documenti: { libretto: v.libretto ?? null, assicurazione: v.assicurazione ?? null, licenza_ncc: v.numero_licenza_ncc ?? null } })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------
// CREATE VEICOLO (CON LOG DI DEBUG)
// ---------------------------------------------------
veicoloRouter.post('/', upload.fields([
    { name: 'libretto', maxCount: 1 },
    { name: 'assicurazione', maxCount: 1 },
    { name: 'licenza_ncc', maxCount: 1 }
]), async (req, res) => {
    console.log("DEBUG [POST] Body:", req.body);
    console.log("DEBUG [POST] Files:", req.files);

    try {
        const data = normalizeInput(req.body);
        const coord = await buildCoord(data.lat, data.lon, data.localita);

        const result = await pool.query(`
            INSERT INTO veicolo (driver_id, marca, modello, posti_totali, raggio_km, targa, servizi, tipo, anno, coord, localita, image_url)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,ST_GeomFromEWKT($10),$11,$12)
            RETURNING *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat
        `, [
            req.user.id, data.marca, data.modello, data.posti_totali, data.raggio_km, data.targa, 
            JSON.stringify(data.servizi), data.tipo, data.anno, coord.ewkt, data.localita, data.image_url
        ]);

        res.json(result.rows[0]);
    } catch (err) {
        log(err.message, 'POST');
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------
// UPDATE VEICOLO (CON LOG DI DEBUG)
// ---------------------------------------------------
veicoloRouter.put('/:id', upload.fields([
    { name: 'libretto', maxCount: 1 },
    { name: 'assicurazione', maxCount: 1 },
    { name: 'licenza_ncc', maxCount: 1 }
]), async (req, res) => {
    console.log("DEBUG [PUT] Body:", req.body);
    
    try {
        const data = normalizeInput(req.body);
        const coord = await buildCoord(data.lat, data.lon, data.localita);
        const result = await pool.query(`
            UPDATE veicolo SET marca=$1, modello=$2, posti_totali=$3, raggio_km=$4, targa=$5, servizi=$6::jsonb, tipo=$7, anno=$8, coord=COALESCE(ST_GeomFromEWKT($9), coord), localita=$10, image_url=$11
            WHERE id=$12 AND driver_id=$13 RETURNING *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat
        `, [
            data.marca, data.modello, data.posti_totali, data.raggio_km, data.targa, JSON.stringify(data.servizi), 
            data.tipo, data.anno, coord.ewkt, data.localita, data.image_url, req.params.id, req.user.id
        ]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------
// DELETE
// ---------------------------------------------------
veicoloRouter.delete('/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM veicolo WHERE id=$1 AND driver_id=$2`, [req.params.id, req.user.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default veicoloRouter;