import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import multer from 'multer';

export const veicoloRouter = express.Router();

const upload = multer({
    storage: multer.memoryStorage()
});

/* =======================================================
   NORMALIZE INPUT
======================================================= */

function normalizeInput(b = {}) {
    return {
        marca: b.marca?.trim() || null,
        modello: b.modello?.trim() || null,
        posti_totali: Number(b.posti_totali ?? 1),
        raggio_km: Number(b.raggio_km ?? 50),
        targa: b.targa?.trim().toUpperCase() || null,
        servizi: Array.isArray(b.servizi) ? b.servizi : [],
        tipo: b.tipo || null,
        anno: b.anno ? Number(b.anno) : null,
        lat: b.lat != null ? Number(b.lat) : 0,
        lon: b.lon != null ? Number(b.lon) : 0,
        localita: b.localita || null,
        image_url: b.image_url || null,
        doc_licenza: b.doc_licenza || null,
        doc_comune: b.doc_comune || null
    };
}

/* =======================================================
   AUTH
======================================================= */

veicoloRouter.use(authMiddleware);

/* =======================================================
   DEBUG MIDDLEWARE
======================================================= */

veicoloRouter.use((req, res, next) => {
    console.log("\n==============================");
    console.log("🚗 ROUTER VEICOLO");
    console.log("Metodo:", req.method);
    console.log("URL:", req.originalUrl);
    console.log("Content-Type:", req.headers["content-type"]);
    console.log("Body:", req.body);
    console.log("==============================\n");
    next();
});

/* =======================================================
   🔥 NEW: MARCHE + MODELLI CATALOG (MANCAVA QUESTA ROUTE)
======================================================= */

veicoloRouter.get('/marche-modelli', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, nome, modelli
            FROM marche_modelli
            ORDER BY nome ASC
        `);

        return res.json(result.rows);
    } catch (err) {
        console.error("❌ ERROR [GET /api/veicolo/marche-modelli]");
        console.error(err);

        return res.status(500).json({
            error: err.message
        });
    }
});

/* =======================================================
   GET VEICOLO
======================================================= */

veicoloRouter.get('/', async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT *
            FROM veicolo
            WHERE driver_id = $1
            LIMIT 1
            `,
            [req.user.id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                error: "Veicolo non trovato"
            });
        }

        const veicolo = result.rows[0];

        const docsRes = await pool.query(
            `
            SELECT tipo, url
            FROM documenti_autista
            WHERE autista_id = $1
            AND veicolo_id = $2
            `,
            [req.user.id, veicolo.id]
        );

        const documenti = {
            libretto: null,
            assicurazione: null,
            licenza_ncc: null,
        };

        docsRes.rows.forEach(d => {
            documenti[d.tipo] = d.url;
        });

        return res.json({
            ...veicolo,
            documenti
        });

    } catch (err) {
        console.error("❌ ERROR [GET /api/veicolo]");
        console.error(err);

        return res.status(500).json({
            error: err.message
        });
    }
});

/* =======================================================
   CREA VEICOLO
======================================================= */

veicoloRouter.post('/', async (req, res) => {
    try {
        if (!req.body) {
            return res.status(400).json({ error: "Body mancante" });
        }

        const data = normalizeInput(req.body);

        const result = await pool.query(
            `
            INSERT INTO veicolo
            (
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
                image_url,
                numero_licenza_ncc,
                comune_licenza
            )
            VALUES
            (
                $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,
                ST_SetSRID(ST_MakePoint($10,$11),4326),
                $12,$13,$14,$15
            )
            RETURNING *
            `,
            [
                req.user.id,
                data.marca,
                data.modello,
                data.posti_totali,
                data.raggio_km,
                data.targa,
                JSON.stringify(data.servizi),
                data.tipo,
                data.anno,
                data.lon,
                data.lat,
                data.localita,
                data.image_url,
                data.doc_licenza,
                data.doc_comune
            ]
        );

        return res.status(201).json({
            ...result.rows[0],
            documenti: {}
        });

    } catch (err) {
        console.error("❌ ERROR [POST /api/veicolo]");
        console.error(err);

        return res.status(400).json({ error: err.message });
    }
});

/* =======================================================
   MODIFICA VEICOLO
======================================================= */

veicoloRouter.put('/:id', async (req, res) => {
    try {
        if (!req.body) {
            return res.status(400).json({ error: "Body mancante" });
        }

        const data = normalizeInput(req.body);

        const result = await pool.query(
            `
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
                coord=ST_SetSRID(ST_MakePoint($9,$10),4326),
                localita=$11,
                image_url=$12,
                numero_licenza_ncc=$13,
                comune_licenza=$14
            WHERE id=$15
            AND driver_id=$16
            RETURNING *
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
                data.lon,
                data.lat,
                data.localita,
                data.image_url,
                data.doc_licenza,
                data.doc_comune,
                req.params.id,
                req.user.id
            ]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Veicolo non trovato" });
        }

        return res.json({
            ...result.rows[0],
            documenti: {}
        });

    } catch (err) {
        console.error(`❌ ERROR [PUT /api/veicolo/${req.params.id}]`);
        console.error(err);

        return res.status(400).json({ error: err.message });
    }
});

/* =======================================================
   DOCUMENTI UPLOAD
======================================================= */

veicoloRouter.post('/documenti', upload.any(), async (req, res) => {
    console.log("📄 File ricevuti:");
    console.log(req.files);

    return res.json({ success: true });
});