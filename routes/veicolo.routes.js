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

/* =======================================================
   MIDDLEWARE DI LOG DIAGNOSTICO (PER IL DEBUG)
======================================================= */
veicoloRouter.use((req, res, next) => {
    console.log(`\n🚀 [INCOMING REQUEST] ${req.method} ${req.originalUrl}`);
    console.log("   Headers:", JSON.stringify(req.headers, null, 2));
    if (req.headers['content-type']?.includes('multipart/form-data')) {
        console.log("   ⚠️ Tipologia: MULTIPART/FORM-DATA rilevato");
    }
    next();
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
   MARCHE + MODELLI
======================================================= */

veicoloRouter.get('/marche-modelli', async (req, res) => {
    try {
        const filePath = path.resolve(process.cwd(), 'data', 'marche_modelli.json');
        if (!fs.existsSync(filePath)) {
            return res.status(500).json({ error: 'File non trovato' });
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        return res.json(JSON.parse(raw));
    } catch (err) {
        console.error("❌ ERROR [GET /api/veicolo/marche-modelli]", err);
        return res.status(500).json({ error: err.message });
    }
});

/* =======================================================
   GET VEICOLI
======================================================= */

veicoloRouter.get('/', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM veicolo WHERE driver_id = $1`, [req.user.id]);
        if (result.rowCount === 0) return res.json([]);

        const veicoliConDocumenti = await Promise.all(result.rows.map(async (veicolo) => {
            const docsRes = await pool.query(
                `SELECT tipo, url FROM documenti_autista WHERE autista_id = $1 AND veicolo_id = $2`,
                [req.user.id, veicolo.id]
            );
            const documenti = { libretto: null, assicurazione: null, licenza_ncc: null };
            docsRes.rows.forEach(d => documenti[d.tipo] = d.url);
            return { ...veicolo, documenti };
        }));
        return res.json(veicoliConDocumenti);
    } catch (err) {
        console.error("❌ ERROR [GET /api/veicolo]", err);
        return res.status(500).json({ error: err.message });
    }
});

/* =======================================================
   CREA VEICOLO
======================================================= */

veicoloRouter.post('/', async (req, res) => {
    try {
        const data = normalizeInput(req.body);
        const result = await pool.query(
            `INSERT INTO veicolo (driver_id, marca, modello, posti_totali, raggio_km, targa, servizi, tipo, anno, coord, localita, image_url, numero_licenza_ncc, comune_licenza)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9, ST_SetSRID(ST_MakePoint($10,$11),4326), $12,$13,$14,$15) RETURNING *`,
            [req.user.id, data.marca, data.modello, data.posti_totali, data.raggio_km, data.targa, JSON.stringify(data.servizi), data.tipo, data.anno, data.lon, data.lat, data.localita, data.image_url, data.doc_licenza, data.doc_comune]
        );
        return res.status(201).json({ ...result.rows[0], documenti: {} });
    } catch (err) {
        console.error("❌ ERROR [POST /api/veicolo]", err);
        return res.status(400).json({ error: err.message });
    }
});

/* =======================================================
   UPDATE VEICOLO
======================================================= */

veicoloRouter.put('/:id', async (req, res) => {
    try {
        const data = normalizeInput(req.body);
        const result = await pool.query(
            `UPDATE veicolo SET marca=$1, modello=$2, posti_totali=$3, raggio_km=$4, targa=$5, servizi=$6::jsonb, tipo=$7, anno=$8, coord=ST_SetSRID(ST_MakePoint($9,$10),4326), localita=$11, image_url=$12, numero_licenza_ncc=$13, comune_licenza=$14 
             WHERE id=$15 AND driver_id=$16 RETURNING *`,
            [data.marca, data.modello, data.posti_totali, data.raggio_km, data.targa, JSON.stringify(data.servizi), data.tipo, data.anno, data.lon, data.lat, data.localita, data.image_url, data.doc_licenza, data.doc_comune, req.params.id, req.user.id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: "Veicolo non trovato" });
        return res.json({ ...result.rows[0], documenti: {} });
    } catch (err) {
        console.error("❌ ERROR [PUT /api/veicolo]", err);
        return res.status(400).json({ error: err.message });
    }
});

/* =======================================================
   DOCUMENTI UPLOAD DEBUG
======================================================= */

veicoloRouter.post('/documenti', upload.any(), async (req, res) => {
    console.log("🔍 [DEBUG DOCUMENTI] Body:", req.body);
    console.log("🔍 [DEBUG DOCUMENTI] Files:", req.files ? req.files.map(f => f.originalname) : "Nessun file");
    
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "Nessun file ricevuto dal server" });
    }
    
    return res.json({ success: true, count: req.files.length });
});