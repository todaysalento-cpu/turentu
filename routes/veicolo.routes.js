import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { CacheManager } from '../utils/cacheManager.js';
import { upsertVeicolo, removeVeicolo } from '../services/search/search.cache.js'; 
import fs from 'fs';
import path from 'path';

export const veicoloRouter = express.Router();

// Utility logger
const log = (msg, id = 'SYSTEM') => console.log(`[VeicoloRouter] [${id}] ${new Date().toISOString()} - ${msg}`);

// ---------------------------------------------------
// ROTTE PUBBLICHE (Senza autenticazione)
// ---------------------------------------------------
// Spostiamo queste rotte PRIMA dell'uso del middleware
veicoloRouter.get('/marche-modelli', async (req, res) => {
    log('Richiesta ricevuta per: /marche-modelli');
    try {
        const now = Date.now();
        if (cache.marcheModelli.data.length && now - cache.marcheModelli.lastFetch < CACHE_TTL) {
            log('Servito da cache in memoria');
            return res.json(cache.marcheModelli.data);
        }

        const localFile = path.join(process.cwd(), 'data', 'marche_modelli.json');
        log(`Tentativo lettura file: ${localFile}`);

        if (!fs.existsSync(localFile)) {
            log('ERRORE: File marche_modelli.json non trovato!');
            return res.status(500).json({ error: 'File dati non disponibile' });
        }

        const raw = await fs.promises.readFile(localFile, 'utf-8');
        const jsonData = JSON.parse(raw);
        
        log(`File letto. Record trovati: ${Array.isArray(jsonData) ? jsonData.length : 'N/A'}`);
        
        cache.marcheModelli = { data: jsonData, lastFetch: now };
        res.json(jsonData);
    } catch (err) { 
        log(`Errore critico in /marche-modelli: ${err.message}`);
        res.status(500).json({ error: 'Errore caricamento marche-modelli' }); 
    }
});

veicoloRouter.get('/tipi', (req, res) => res.json(TIPI_VEICOLO));

// ---------------------------------------------------
// MIDDLEWARE AUTENTICAZIONE (Solo dopo le rotte pubbliche)
// ---------------------------------------------------
veicoloRouter.use(authMiddleware);

// ---------------------------------------------------
// ROTTE PRIVATE
// ---------------------------------------------------
veicoloRouter.get('/check-targa', async (req, res) => {
    try {
        let { targa, id } = req.query;
        if (!targa) return res.status(400).json({ error: 'Targa mancante' });
        
        const parsedId = (id === 'undefined' || id === '' || !id) ? null : Number(id);
        let query = 'SELECT 1 FROM veicolo WHERE targa = $1';
        let params = [targa.toString().toUpperCase()];

        if (parsedId) {
            query += ' AND id != $2';
            params.push(parsedId);
        }
        
        const result = await pool.query(query, params);
        res.json({ inUse: result.rowCount > 0 });
    } catch (err) { 
        log(`Errore in /check-targa: ${err.message}`);
        res.status(500).json({ error: 'Errore interno' }); 
    }
});

veicoloRouter.get('/', async (req, res) => {
    try {
        const veicoloRes = await pool.query(`SELECT *, ST_X(coord::geometry) AS lon, ST_Y(coord::geometry) AS lat FROM veicolo WHERE driver_id=$1 ORDER BY id DESC`, [req.user.id]);
        res.json(veicoloRes.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ... (POST, PUT, DELETE rimangono invariati ma saranno protetti dal middleware) ...

export default veicoloRouter;