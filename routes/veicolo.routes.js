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
    lat: (b.lat != null && Number(b.lat) !== 0) ? Number(b.lat) : null,
    lon: (b.lon != null && Number(b.lon) !== 0) ? Number(b.lon) : null,
    localita: b.localita || null,
    image_url: b.image_url || null,
    doc_licenza: b.doc_licenza || null,
    doc_comune: b.doc_comune || null
});

/* =======================================================
   ROTTE
======================================================= */

// Check Targa
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

// Marque & Modelli
veicoloRouter.get('/marche-modelli', (req, res) => {
    try {
        const filePath = path.resolve(process.cwd(), 'data', 'marche_modelli.json');
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Errore caricamento dati" });
    }
});

// GET Veicoli (CON JOIN DOCUMENTI)
veicoloRouter.get('/', async (req, res) => {
    try {
        const query = `
            SELECT v.*, 
                   json_agg(json_build_object('tipo', d.tipo, 'url', d.url, 'stato', d.stato)) 
                   FILTER (WHERE d.tipo IS NOT NULL) as documenti_array
            FROM veicolo v
            LEFT JOIN documenti_autista d ON v.id = d.veicolo_id
            WHERE v.driver_id = $1
            GROUP BY v.id`;
        
        const { rows } = await pool.query(query, [req.user.id]);

        // Mappatura per formattare come atteso dal frontend
        const veicoliNormalizzati = rows.map(v => {
            const docs = { libretto: null, assicurazione: null, licenza_ncc: null };
            if (v.documenti_array) {
                v.documenti_array.forEach(d => {
                    if (docs.hasOwnProperty(d.tipo)) {
                        docs[d.tipo] = { url: d.url, stato: d.stato };
                    }
                });
            }
            // Rimuoviamo il campo temporaneo usato per il JSON
            delete v.documenti_array;
            return { ...v, documenti: docs };
        });

        res.json(veicoliNormalizzati);
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
        // Aggiungiamo struttura documenti vuota per coerenza
        res.status(201).json({ ...rows[0], documenti: { libretto: null, assicurazione: null, licenza_ncc: null } });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// UPDATE Veicolo
veicoloRouter.put('/:id', async (req, res) => {
    try {
        const d = normalizeInput(req.body);
        
        console.log("🛠️ [Backend UPDATE] Dati normalizzati ricevuti:", { lat: d.lat, lon: d.lon, localita: d.localita });

        const hasCoordinates = d.lat != null && d.lon != null;
        let query;
        let queryParams;

        if (hasCoordinates) {
            // Se sono presenti nuove coordinate valide, aggiorniamo anche la colonna coord
            query = `
                UPDATE veicolo 
                SET marca=$1, modello=$2, posti_totali=$3, raggio_km=$4, targa=$5, 
                    servizi=$6::jsonb, tipo=$7, anno=$8, 
                    coord=ST_SetSRID(ST_MakePoint($9, $10), 4326), 
                    localita=$11, image_url=$12, numero_licenza_ncc=$13, comune_licenza=$14
                WHERE id=$15 AND driver_id=$16 
                RETURNING *`;
            
            queryParams = [
                d.marca, d.modello, d.posti_totali, d.raggio_km, d.targa, 
                JSON.stringify(d.servizi), d.tipo, d.anno, 
                d.lon, d.lat, d.localita, d.image_url, 
                d.doc_licenza, d.doc_comune, req.params.id, req.user.id
            ];
        } else {
            // Se non ci sono nuove coordinate, aggiorniamo i dati testuali ma lasciamo inalterata la colonna coord esistente
            query = `
                UPDATE veicolo 
                SET marca=$1, modello=$2, posti_totali=$3, raggio_km=$4, targa=$5, 
                    servizi=$6::jsonb, tipo=$7, anno=$8, 
                    localita=COALESCE($9, localita), image_url=$10, numero_licenza_ncc=$11, comune_licenza=$12
                WHERE id=$13 AND driver_id=$14 
                RETURNING *`;
            
            queryParams = [
                d.marca, d.modello, d.posti_totali, d.raggio_km, d.targa, 
                JSON.stringify(d.servizi), d.tipo, d.anno, 
                d.localita, d.image_url, d.doc_licenza, d.doc_comune, 
                req.params.id, req.user.id
            ];
        }
        
        const { rows, rowCount } = await pool.query(query, queryParams);

        if (!rowCount) return res.status(404).json({ error: "Veicolo non trovato" });
        
        // Mantieni i documenti esistenti nel ritorno
        res.json({ ...rows[0], documenti: req.body.documenti || { libretto: null, assicurazione: null, licenza_ncc: null } });
    } catch (err) {
        console.error("❌ [Backend UPDATE Error]:", err.message);
        res.status(400).json({ error: err.message });
    }
});