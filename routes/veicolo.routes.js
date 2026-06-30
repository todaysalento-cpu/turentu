import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';

export const veicoloRouter = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

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
        doc_licenza: b.documenti?.licenza_ncc || null,
        doc_comune: b.documenti?.comune || null
    };
}

veicoloRouter.use(authMiddleware);

// -------------------------
// GET MARCHE E MODELLI
// -------------------------
veicoloRouter.get('/marche-modelli', async (req, res) => {
    try {
        const filePath = path.join(process.cwd(), 'data', 'marche_modelli.json');
        const fileContent = await fs.readFile(filePath, 'utf-8');
        res.json(JSON.parse(fileContent));
    } catch (err) {
        res.status(500).json({ error: "Errore catalogo", details: err.message });
    }
});

// -------------------------
// GET VEICOLI (AGGIORNATO CON JOIN)
// -------------------------
veicoloRouter.get('/', async (req, res) => {
    try {
        // Usiamo una JOIN per aggregare i documenti dalla tabella dedicata
        const query = `
            SELECT v.*, 
                   ST_X(v.coord::geometry) AS lon, 
                   ST_Y(v.coord::geometry) AS lat,
                   json_object_agg(d.tipo, d.url) FILTER (WHERE d.tipo IS NOT NULL) AS docs_json
            FROM veicolo v
            LEFT JOIN documenti_autista d ON v.id = d.veicolo_id
            WHERE v.driver_id = $1
            GROUP BY v.id
            ORDER BY v.id DESC
        `;
        
        const result = await pool.query(query, [req.user.id]);
        
        // Formattiamo la risposta per il frontend
        const veicoli = result.rows.map(v => ({
            ...v,
            documenti: v.docs_json || { libretto: null, assicurazione: null, licenza_ncc: null }
        }));
        
        res.json(veicoli);
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
            INSERT INTO veicolo (
                driver_id, marca, modello, posti_totali, raggio_km, targa, 
                servizi, tipo, anno, coord, localita, image_url, numero_licenza_ncc, comune_licenza
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, ST_SetSRID(ST_MakePoint($10, $11), 4326), $12, $13, $14, $15)
            RETURNING *
        `, [
            req.user.id, data.marca, data.modello, data.posti_totali, data.raggio_km, data.targa,
            JSON.stringify(data.servizi), data.tipo, data.anno,
            data.lon, data.lat, data.localita, data.image_url, data.doc_licenza, data.doc_comune
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
            UPDATE veicolo SET 
                marca=$1, modello=$2, posti_totali=$3, raggio_km=$4, targa=$5, 
                servizi=$6::jsonb, tipo=$7, anno=$8, coord=ST_SetSRID(ST_MakePoint($9, $10), 4326), 
                localita=$11, image_url=$12, numero_licenza_ncc=$13, comune_licenza=$14
            WHERE id=$15 AND driver_id=$16
            RETURNING *
        `, [
            data.marca, data.modello, data.posti_totali, data.raggio_km, data.targa,
            JSON.stringify(data.servizi), data.tipo, data.anno,
            data.lon, data.lat, data.localita, data.image_url, data.doc_licenza, data.doc_comune,
            req.params.id, req.user.id
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