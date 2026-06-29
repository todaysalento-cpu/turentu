import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';

export const veicoloRouter = express.Router();

// -------------------------
// DEBUG
// -------------------------
veicoloRouter.use((req, res, next) => {
    console.log(`[DEBUG_ROUTER] ${req.method} ${req.originalUrl}`);
    next();
});

// -------------------------
// PARSE BODY SAFE
// -------------------------
const parseBody = (body) => {
    if (typeof body === 'string') {
        try { return JSON.parse(body); } catch { return body; }
    }
    return body;
};

// -------------------------
// TIPI
// -------------------------
export const TIPI_VEICOLO = [
    'citycar', 'berlina', 'station_wagon',
    'suv', 'minivan', 'van', 'luxury', 'electric'
];

// -------------------------
// NORMALIZE INPUT
// -------------------------
function normalizeInput(body) {
    const b = parseBody(body);

    return {
        marca: b.marca?.trim() || null,
        modello: b.modello?.trim() || null,
        posti_totali: Number(b.posti_totali || 1),
        raggio_km: Number(b.raggio_km || 50),
        targa: b.targa?.trim().toUpperCase() || null,
        servizi: b.servizi
            ? (typeof b.servizi === 'string' ? JSON.parse(b.servizi) : b.servizi)
            : [],
        tipo: b.tipo || null,
        anno: b.anno ? Number(b.anno) : null,
        lat: b.lat != null ? Number(b.lat) : null,
        lon: b.lon != null ? Number(b.lon) : null,
        localita: b.localita || null,
        image_url: b.image_url || null
    };
}

// -------------------------
// AUTH
// -------------------------
veicoloRouter.use(authMiddleware);

// -------------------------
// GET VEICOLI (🔥 FIX DOCUMENTI REALI)
// -------------------------
veicoloRouter.get('/', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                v.*,
                ST_X(v.coord::geometry) AS lon,
                ST_Y(v.coord::geometry) AS lat,

                -- 🔥 JOIN DOCUMENTI REALI
                COALESCE(
                    jsonb_object_agg(d.tipo, d.url)
                    FILTER (WHERE d.tipo IS NOT NULL),
                    '{}'::jsonb
                ) AS documenti

            FROM veicolo v
            LEFT JOIN documenti_autista d
                ON d.veicolo_id = v.id

            WHERE v.driver_id = $1
            GROUP BY v.id
            ORDER BY v.id DESC
        `, [req.user.id]);

        res.json(result.rows);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// -------------------------
// CREATE (NO documenti qui)
// -------------------------
veicoloRouter.post('/', async (req, res) => {
    try {
        const data = normalizeInput(req.body);

        const result = await pool.query(`
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
                lat,
                lon,
                localita,
                image_url
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
            RETURNING *
        `, [
            req.user.id,
            data.marca,
            data.modello,
            data.posti_totali,
            data.raggio_km,
            data.targa,
            JSON.stringify(data.servizi),
            data.tipo,
            data.anno,
            data.lat,
            data.lon,
            data.localita,
            data.image_url
        ]);

        res.json(result.rows[0]);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// -------------------------
// UPDATE (NO documenti qui)
// -------------------------
veicoloRouter.put('/:id', async (req, res) => {
    try {
        const data = normalizeInput(req.body);

        const result = await pool.query(`
            UPDATE veicolo
            SET
                marca=$1,
                modello=$2,
                posti_totali=$3,
                raggio_km=$4,
                targa=$5,
                servizi=$6::jsonb,
                tipo=$7,
                anno=$8,
                lat=$9,
                lon=$10,
                localita=$11,
                image_url=$12
            WHERE id=$13 AND driver_id=$14
            RETURNING *
        `, [
            data.marca,
            data.modello,
            data.posti_totali,
            data.raggio_km,
            data.targa,
            JSON.stringify(data.servizi),
            data.tipo,
            data.anno,
            data.lat,
            data.lon,
            data.localita,
            data.image_url,
            req.params.id,
            req.user.id
        ]);

        res.json(result.rows[0]);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// -------------------------
// DELETE
// -------------------------
veicoloRouter.delete('/:id', async (req, res) => {
    try {
        await pool.query(
            `DELETE FROM veicolo WHERE id=$1 AND driver_id=$2`,
            [req.params.id, req.user.id]
        );

        res.json({ success: true });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default veicoloRouter;