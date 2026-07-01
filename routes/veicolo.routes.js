import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import multer from 'multer';
import fs from 'fs';
import path from 'path';

export const veicoloRouter = express.Router();

const upload = multer({
    storage: multer.memoryStorage()
});

console.log("🔥 [VEICOLO ROUTER] FILE CARICATO CORRETTAMENTE");

/* =======================================================
   LOG GLOBALE ROUTER
======================================================= */
veicoloRouter.use((req, res, next) => {
    console.log("\n========================================");
    console.log("🚗 VEICOLO ROUTER");
    console.log("METHOD:", req.method);
    console.log("URL:", req.originalUrl);
    console.log("PATH:", req.path);
    console.log("AUTH:", req.headers.authorization ? "YES" : "NO");
    console.log("CONTENT-TYPE:", req.headers["content-type"]);
    console.log("========================================\n");
    next();
});

/* =======================================================
   AUTH
======================================================= */
veicoloRouter.use((req, res, next) => {
    console.log("🔐 AUTH MIDDLEWARE");
    next();
}, authMiddleware);

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
   CHECK TARGA
======================================================= */

const checkTargaHandler = async (req, res) => {

    console.log("\n================ CHECK TARGA ================");
    console.log("METHOD:", req.method);
    console.log("BODY:", req.body);
    console.log("QUERY:", req.query);
    console.log("USER:", req.user?.id);
    console.log("=============================================\n");

    try {

        const source = req.method === "GET"
            ? req.query
            : req.body;

        const targa = source.targa;
        const id = source.id;

        if (!targa) {
            console.log("❌ TARGA MANCANTE");
            return res.status(400).json({
                error: "Targa mancante"
            });
        }

        const normalized = targa.trim().toUpperCase();

        console.log("🔎 CERCO:", normalized);

        const result = await pool.query(
            `
            SELECT id
            FROM veicolo
            WHERE UPPER(targa)=UPPER($1)
            AND driver_id=$2
            `,
            [
                normalized,
                req.user.id
            ]
        );

        console.log("📦 ROWS:", result.rows);

        const inUse = result.rows.some(
            v => String(v.id) !== String(id)
        );

        console.log("🚨 IN USE:", inUse);

        return res.json({
            inUse
        });

    } catch (err) {

        console.error("💥 CHECK TARGA ERROR");
        console.error(err);

        return res.status(500).json({
            error: err.message
        });

    }

};

veicoloRouter.get('/check-targa', checkTargaHandler);
veicoloRouter.post('/check-targa', checkTargaHandler);

/* =======================================================
   MARCHE MODELLI
======================================================= */

veicoloRouter.get('/marche-modelli', async (req, res) => {

    console.log("📚 GET MARCHE MODELLI");

    try {

        const filePath = path.resolve(
            process.cwd(),
            'data',
            'marche_modelli.json'
        );

        const raw = fs.readFileSync(filePath, 'utf8');

        return res.json(JSON.parse(raw));

    } catch (err) {

        console.error(err);

        return res.status(500).json({
            error: err.message
        });

    }

});

/* =======================================================
   GET VEICOLI
======================================================= */

veicoloRouter.get('/', async (req, res) => {

    console.log("📦 GET VEICOLI");

    try {

        const result = await pool.query(
            `
            SELECT *
            FROM veicolo
            WHERE driver_id=$1
            `,
            [
                req.user.id
            ]
        );

        return res.json(result.rows);

    } catch (err) {

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

    console.log("🆕 CREA VEICOLO");

    try {

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
                $1,$2,$3,$4,$5,$6,
                $7::jsonb,
                $8,$9,
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

        return res.status(201).json(result.rows[0]);

    } catch (err) {

        console.error(err);

        return res.status(400).json({
            error: err.message
        });

    }

});

/* =======================================================
   UPDATE VEICOLO
======================================================= */

veicoloRouter.put('/:id', async (req, res) => {

    console.log("✏️ UPDATE", req.params.id);

    try {

        const data = normalizeInput(req.body);

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

        if (!result.rowCount) {
            return res.status(404).json({
                error: "Veicolo non trovato"
            });
        }

        return res.json(result.rows[0]);

    } catch (err) {

        console.error(err);

        return res.status(400).json({
            error: err.message
        });

    }

});

/* =======================================================
   DOCUMENTI
======================================================= */

veicoloRouter.post('/documenti', upload.any(), async (req, res) => {

    console.log("📎 DOCUMENTI");
    console.log("BODY:", req.body);
    console.log("FILES:", req.files);

    if (!req.files?.length) {
        return res.status(400).json({
            error: "Nessun file ricevuto"
        });
    }

    return res.json({
        success: true
    });

});