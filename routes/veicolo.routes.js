import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import multer from 'multer';

export const veicoloRouter = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// -------------------------
// DEBUG
// -------------------------
veicoloRouter.use((req, res, next) => {
    console.log(`[DEBUG_ROUTER] ${req.method} ${req.originalUrl}`);
    next();
});

// -------------------------
// UTILS
// -------------------------
const parseBody = (body) => {
    if (typeof body === 'string') {
        try { return JSON.parse(body); } catch { return body; }
    }
    return body;
};

function normalizeInput(body) {
    const b = parseBody(body);
    return {
        marca: b.marca?.trim() || null,
        modello: b.modello?.trim() || null,
        posti_totali: Number(b.posti_totali || 1),
        raggio_km: Number(b.raggio_km || 50),
        targa: b.targa?.trim().toUpperCase() || null,
        servizi: b.servizi ? (typeof b.servizi === 'string' ? JSON.parse(b.servizi) : b.servizi) : [],
        tipo: b.tipo || null,
        anno: b.anno ? Number(b.anno) : null,
        lat: b.lat != null ? Number(b.lat) : null,
        lon: b.lon != null ? Number(b.lon) : null,
        localita: b.localita || null,
        image_url: b.image_url || null,
        documenti: b.documenti ? (typeof b.documenti === 'string' ? JSON.parse(b.documenti) : b.documenti) : {
            libretto: null, assicurazione: null, licenza_ncc: null
        }
    };
}

// -------------------------
// AUTH OBBLIGATORIA
// -------------------------
veicoloRouter.use(authMiddleware);

// -------------------------
// NEW: GET MARCHE E MODELLI
// -------------------------
// Risolve l'errore 404 visto nei tuoi log
veicoloRouter.get('/marche-modelli', async (req, res) => {
    try {
        // Supponendo che tu abbia una tabella 'catalogo_veicoli'
        const result = await pool.query('SELECT id, nome, modelli FROM catalogo_veicoli ORDER BY nome ASC');
        res.json(result.rows);
    } catch (err) {
        console.error("Errore fetch marche-modelli:", err);
        res.status(500).json({ error: "Impossibile recuperare il catalogo" });
    }
});

// -------------------------
// GET VEICOLI
// -------------------------
veicoloRouter.get('/', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT *,
                   ST_X(coord::geometry) AS lon,
                   ST_Y(coord::geometry) AS lat
            FROM veicolo
            WHERE driver_id=$1
            ORDER BY id DESC
        `, [req.user.id]);

        const rows = result.rows.map(v => ({
            ...v,
            documenti: v.documenti || { libretto: null, assicurazione: null, licenza_ncc: null }
        }));
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------
// CREATE
// -------------------------
veicoloRouter.post('/', upload.none(), async (req, res) => {
    try {
        const data = normalizeInput(req.body);
        const result = await pool.query(`
            INSERT INTO veicolo (driver_id, marca, modello, posti_totali, raggio_km, targa, servizi, tipo, anno, lat, lon, localita, image_url, documenti)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb)
            RETURNING *
        `, [
            req.user.id, data.marca, data.modello, data.posti_totali, data.raggio_km, data.targa,
            JSON.stringify(data.servizi), data.tipo, data.anno, data.lat, data.lon, data.localita,
            data.image_url, JSON.stringify(data.documenti)
        ]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------
// UPDATE
// -------------------------
veicoloRouter.put('/:id', upload.none(), async (req, res) => {
    try {
        const data = normalizeInput(req.body);
        const result = await pool.query(`
            UPDATE veicolo SET marca=$1, modello=$2, posti_totali=$3, raggio_km=$4, targa=$5, servizi=$6::jsonb, tipo=$7, anno=$8, lat=$9, lon=$10, localita=$11, image_url=$12, documenti=$13::jsonb
            WHERE id=$14 AND driver_id=$15
            RETURNING *
        `, [
            data.marca, data.modello, data.posti_totali, data.raggio_km, data.targa,
            JSON.stringify(data.servizi), data.tipo, data.anno, data.lat, data.lon, data.localita,
            data.image_url, JSON.stringify(data.documenti), req.params.id, req.user.id
        ]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------
// DELETE
// -------------------------
veicoloRouter.delete('/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM veicolo WHERE id=$1 AND driver_id=$2`, [req.params.id, req.user.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});