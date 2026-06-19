import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { CacheManager } from '../utils/cacheManager.js';
import { upsertVeicolo, removeVeicolo } from '../services/search/search.cache.js'; 
import fs from 'fs';
import path from 'path';

export const veicoloRouter = express.Router();

// ---------------------------------------------------
// CONFIGURAZIONI E VARIABILI GLOBALI
// ---------------------------------------------------
const CACHE_TTL = 1000 * 60 * 60; // 1 ora
const cache = { marcheModelli: { data: [], lastFetch: 0 } };
export const TIPI_VEICOLO = ['citycar', 'berlina', 'station_wagon', 'suv', 'minivan', 'van', 'luxury', 'electric'];
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const TARGA_REGEX = /^[A-Z]{2}[0-9]{3}[A-Z]{2}$/;

const log = (msg, id = 'SYSTEM') => console.log(`[VeicoloRouter] [${id}] ${new Date().toISOString()} - ${msg}`);

// ---------------------------------------------------
// HELPER FUNCTIONS
// ---------------------------------------------------
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
    if (data.targa && !TARGA_REGEX.test(data.targa)) return 'Formato targa non valido';
    return null;
}

async function buildCoord(lat, lon, localita) {
    if ((lat == null || lon == null) && localita) {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(localita)}&key=${GOOGLE_MAPS_API_KEY}&region=it`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.results?.length) return { lat: data.results[0].geometry.location.lat, lon: data.results[0].geometry.location.lng, ewkt: `SRID=4326;POINT(${data.results[0].geometry.location.lng} ${data.results[0].geometry.location.lat})` };
    }
    return { lat, lon, ewkt: lat && lon ? `SRID=4326;POINT(${lon} ${lat})` : null };
}

// ---------------------------------------------------
// ROTTE PUBBLICHE
// ---------------------------------------------------
veicoloRouter.get('/marche-modelli', async (req, res) => {
    try {
        const now = Date.now();
        if (cache.marcheModelli.data.length && now - cache.marcheModelli.lastFetch < CACHE_TTL) return res.json(cache.marcheModelli.data);
        
        const localFile = path.join(process.cwd(), 'data', 'marche_modelli.json');
        const raw = await fs.promises.readFile(localFile, 'utf-8');
        const jsonData = JSON.parse(raw);
        cache.marcheModelli = { data: jsonData, lastFetch: now };
        res.json(jsonData);
    } catch (err) { res.status(500).json({ error: 'Errore caricamento catalogo' }); }
});

veicoloRouter.get('/tipi', (req, res) => res.json(TIPI_VEICOLO));

// ---------------------------------------------------
// MIDDLEWARE PROTEZIONE
// ---------------------------------------------------
veicoloRouter.use(authMiddleware);

// ---------------------------------------------------
// ROTTE PRIVATE
// ---------------------------------------------------
veicoloRouter.get('/', async (req, res) => {
    try {
        const veicoli = await pool.query(`SELECT *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat FROM veicolo WHERE driver_id=$1 ORDER BY id DESC`, [req.user.id]);
        res.json(veicoli.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

veicoloRouter.post('/', async (req, res) => {
    try {
        const data = normalizeInput(req.body);
        const error = validateVeicolo(data);
        if (error) return res.status(400).json({ error });
        const coord = await buildCoord(data.lat, data.lon, data.localita);
        
        const result = await pool.query(`
            INSERT INTO veicolo (driver_id, marca, modello, posti_totali, raggio_km, targa, servizi, tipo, anno, coord, localita, image_url)
            VALUES ($1,$2,$3,$4,$5,$6, $7::jsonb, $8,$9, ST_GeomFromEWKT($10), $11, $12)
            RETURNING *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat`,
            [req.user.id, data.marca, data.modello, data.posti_totali, data.raggio_km, data.targa, JSON.stringify(data.servizi), data.tipo, data.anno, coord.ewkt, data.localita, data.image_url]
        );
        await CacheManager.veicolo.update(result.rows[0]);
        upsertVeicolo(result.rows[0]);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

veicoloRouter.put('/:id', async (req, res) => {
    try {
        const data = normalizeInput(req.body);
        const coord = await buildCoord(data.lat, data.lon, data.localita);
        const result = await pool.query(`
            UPDATE veicolo SET marca=$1, modello=$2, posti_totali=$3, raggio_km=$4, targa=$5, servizi=$6::jsonb, tipo=$7, anno=$8,
            coord = COALESCE(ST_GeomFromEWKT($9), coord), localita=$10, image_url=$11
            WHERE id=$12 AND driver_id=$13
            RETURNING *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat`,
            [data.marca, data.modello, data.posti_totali, data.raggio_km, data.targa, JSON.stringify(data.servizi), data.tipo, data.anno, coord.ewkt, data.localita, data.image_url, req.params.id, req.user.id]
        );
        if (!result.rowCount) return res.status(404).json({ error: 'Veicolo non trovato' });
        await CacheManager.veicolo.delete(Number(req.params.id));
        await CacheManager.veicolo.update(result.rows[0]);
        upsertVeicolo(result.rows[0]);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

veicoloRouter.delete('/:id', async (req, res) => {
    try {
        const result = await pool.query(`DELETE FROM veicolo WHERE id=$1 AND driver_id=$2 RETURNING *`, [req.params.id, req.user.id]);
        if (!result.rowCount) return res.status(404).json({ error: 'Veicolo non trovato' });
        await CacheManager.veicolo.delete(Number(req.params.id));
        removeVeicolo(Number(req.params.id));
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

export default veicoloRouter;