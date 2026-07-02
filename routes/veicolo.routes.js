import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';

export const veicoloRouter = express.Router();

/* =======================================================
   MIDDLEWARE GLOBALI
======================================================= */
veicoloRouter.use(authMiddleware);

/* =======================================================
   HELPERS
======================================================= */
const normalizeInput = (b = {}) => ({
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
});

/* =======================================================
   ROTTE
======================================================= */

// Check Targa (Consolidato in una sola rotta POST)
veicoloRouter.post('/check-targa', async (req, res) => {
    try {
        const { targa, id } = req.body;
        if (!targa) return res.status(400).json({ error: "Targa mancante" });

        const result = await pool.query(
            "SELECT id FROM veicolo WHERE UPPER(targa)=UPPER($1) AND driver_id=$2",
            [targa.trim().toUpperCase(), req.user.id]
        );

        const inUse = result.rows.some(v => String(v.id) !== String(id));
        res.json({ inUse });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Marque & Modelli (Lettura statica)
veicoloRouter.get('/marche-modelli', (req, res) => {
    try {
        const filePath = path.resolve(process.cwd(), 'data', 'marche_modelli.json');
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Errore caricamento dati" });
    }
});

// GET Veicoli
veicoloRouter.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM veicolo WHERE driver_id=$1", [req.user.id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// CREATE Veicolo
veicoloRouter.post('/', async (req, res) => {
    try {
        const d = normalizeInput(req.body);
        const query = `
            INSERT INTO veicolo (driver_id, marca, modello, posti_totali, raggio_km, targa, servizi, tipo, anno, coord, localita, image_url, numero_licenza_ncc, comune_licenza)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, ST_SetSRID(ST_MakePoint($10,$11),4326), $12, $13, $14, $15)
            RETURNING *`;
        
        const { rows } = await pool.query(query, [
            req.user.id, d.marca, d.modello, d.posti_totali, d.raggio_km, d.targa, 
            JSON.stringify(d.servizi), d.tipo, d.anno, d.lon, d.lat, 
            d.localita, d.image_url, d.doc_licenza, d.doc_comune
        ]);
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// UPDATE Veicolo
veicoloRouter.put('/:id', async (req, res) => {
    try {
        const d = normalizeInput(req.body);
        const query = `
            UPDATE veicolo SET marca=$1, modello=$2, posti_totali=$3, raggio_km=$4, targa=$5, servizi=$6::jsonb, tipo=$7, anno=$8, coord=ST_SetSRID(ST_MakePoint($9,$10),4326), localita=$11, image_url=$12, numero_licenza_ncc=$13, comune_licenza=$14
            WHERE id=$15 AND driver_id=$16 RETURNING *`;
        
        const { rows, rowCount } = await pool.query(query, [
            d.marca, d.modello, d.posti_totali, d.raggio_km, d.targa, JSON.stringify(d.servizi), 
            d.tipo, d.anno, d.lon, d.lat, d.localita, d.image_url, d.doc_licenza, 
            d.doc_comune, req.params.id, req.user.id
        ]);

        if (!rowCount) return res.status(404).json({ error: "Veicolo non trovato" });
        res.json(rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});