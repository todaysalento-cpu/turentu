import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { processAccountRemovals } from '../services/auth/account-removals.service.js';
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
const validateCapacity = (body) => {
    const category = String(body.tipo ?? '').trim().toLowerCase();
    const max = category === 'bus' ? 150 : category === 'minibus' ? 35 : 9;
    const seats = Number(body.posti_totali ?? 1);
    if (!Number.isInteger(seats) || seats < 1 || seats > max) throw new Error('Numero di posti non compatibile con il tipo di veicolo.');
};
const normalizeInput = (b = {}) => ({
    marca: b.marca?.trim() || null,
    modello: b.modello?.trim() || null,
    posti_totali: Number(b.posti_totali ?? 1),
    raggio_km: Number(b.raggio_km ?? 50),
    targa: b.targa?.trim().toUpperCase() || null,
    servizi: Array.isArray(b.servizi) ? b.servizi : [],
    tipo: b.tipo || null,
    anno: b.anno ? Number(b.anno) : null,
    lat: (b.lat != null && !isNaN(Number(b.lat)) && Number(b.lat) !== 0) ? Number(b.lat) : null,
    lon: (b.lon != null && !isNaN(Number(b.lon)) && Number(b.lon) !== 0) ? Number(b.lon) : null,
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

// GET Veicoli (CON JOIN DOCUMENTI E ESTRAZIONE LAT/LON)
veicoloRouter.get('/', async (req, res) => {
    try {
        const query = `
            SELECT v.*, 
                   ST_Y(v.coord::geometry) as lat,
                   ST_X(v.coord::geometry) as lon,
                   json_agg(json_build_object('tipo', d.tipo, 'url', d.url, 'stato', d.stato)) 
                   FILTER (WHERE d.tipo IS NOT NULL) as documenti_array
            FROM veicolo v
            LEFT JOIN documenti_autista d ON v.id = d.veicolo_id
            WHERE v.driver_id = $1 AND v.stato IS DISTINCT FROM 'eliminato'
            GROUP BY v.id`;
        
        const { rows } = await pool.query(query, [req.user.id]);

        const veicoliNormalizzati = rows.map(v => {
            const docs = { libretto: null, assicurazione: null, licenza_ncc: null };
            if (v.documenti_array) {
                v.documenti_array.forEach(d => {
                    if (docs.hasOwnProperty(d.tipo)) {
                        docs[d.tipo] = { url: d.url, stato: d.stato };
                    }
                });
            }
            delete v.documenti_array;
            return { 
                ...v, 
                lat: v.lat != null ? Number(v.lat) : null,
                lon: v.lon != null ? Number(v.lon) : null,
                documenti: docs 
            };
        });

        res.json(veicoliNormalizzati);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// CREATE Veicolo
veicoloRouter.post('/', async (req, res) => {
    try {
        validateCapacity(req.body);
        const d = normalizeInput(req.body);
        const query = `
            INSERT INTO veicolo (driver_id, marca, modello, posti_totali, raggio_km, targa, servizi, tipo, anno, coord, localita, image_url, numero_licenza_ncc, comune_licenza)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, ST_SetSRID(ST_MakePoint($10,$11),4326), $12, $13, $14, $15)
            RETURNING *, ST_Y(coord::geometry) as lat, ST_X(coord::geometry) as lon`;
        
        const { rows } = await pool.query(query, [
            req.user.id, d.marca, d.modello, d.posti_totali, d.raggio_km, d.targa, 
            JSON.stringify(d.servizi), d.tipo, d.anno, d.lon, d.lat, 
            d.localita, d.image_url, d.doc_licenza, d.doc_comune
        ]);

        const newVehicle = rows[0];
        res.status(201).json({ 
            ...newVehicle, 
            lat: newVehicle.lat != null ? Number(newVehicle.lat) : null,
            lon: newVehicle.lon != null ? Number(newVehicle.lon) : null,
            documenti: { libretto: null, assicurazione: null, licenza_ncc: null } 
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// UPDATE Veicolo
veicoloRouter.put('/:id', async (req, res) => {
    try {
        validateCapacity(req.body);
        const d = normalizeInput(req.body);
        
        console.log("🛠️ [Backend UPDATE] Dati normalizzati ricevuti:", { lat: d.lat, lon: d.lon, localita: d.localita });

        const hasCoordinates = d.lat != null && d.lon != null;
        let query;
        let queryParams;

        if (hasCoordinates) {
            query = `
                UPDATE veicolo 
                SET marca=$1, modello=$2, posti_totali=$3, raggio_km=$4, targa=$5, 
                    servizi=$6::jsonb, tipo=$7, anno=$8, 
                    coord=ST_SetSRID(ST_MakePoint($9, $10), 4326), 
                    localita=$11, image_url=$12, numero_licenza_ncc=$13, comune_licenza=$14
                WHERE id=$15 AND driver_id=$16 AND stato IS DISTINCT FROM 'eliminato'
                RETURNING *, ST_Y(coord::geometry) as lat, ST_X(coord::geometry) as lon`;
            
            queryParams = [
                d.marca, d.modello, d.posti_totali, d.raggio_km, d.targa, 
                JSON.stringify(d.servizi), d.tipo, d.anno, 
                d.lon, d.lat, d.localita, d.image_url, 
                d.doc_licenza, d.doc_comune, req.params.id, req.user.id
            ];
        } else {
            // Se non ci sono nuove coordinate nel payload, manteniamo coord e localita esistenti se non specificate
            query = `
                UPDATE veicolo 
                SET marca=$1, modello=$2, posti_totali=$3, raggio_km=$4, targa=$5, 
                    servizi=$6::jsonb, tipo=$7, anno=$8, 
                    localita=COALESCE($9, localita), image_url=$10, numero_licenza_ncc=$11, comune_licenza=$12
                WHERE id=$13 AND driver_id=$14 AND stato IS DISTINCT FROM 'eliminato'
                RETURNING *, ST_Y(coord::geometry) as lat, ST_X(coord::geometry) as lon`;
            
            queryParams = [
                d.marca, d.modello, d.posti_totali, d.raggio_km, d.targa, 
                JSON.stringify(d.servizi), d.tipo, d.anno, 
                d.localita, d.image_url, d.doc_licenza, d.doc_comune, 
                req.params.id, req.user.id
            ];
        }
        
        const { rows, rowCount } = await pool.query(query, queryParams);

        if (!rowCount) return res.status(404).json({ error: "Veicolo non trovato" });
        
        const updatedVehicle = rows[0];

        res.json({ 
            ...updatedVehicle, 
            lat: updatedVehicle.lat != null ? Number(updatedVehicle.lat) : null,
            lon: updatedVehicle.lon != null ? Number(updatedVehicle.lon) : null,
            documenti: req.body.documenti || { libretto: null, assicurazione: null, licenza_ncc: null } 
        });
    } catch (err) {
        console.error("❌ [Backend UPDATE Error]:", err.message);
        res.status(400).json({ error: err.message });
    }
});

// Archivia i veicoli con storico mantenendo i dati collegati.
veicoloRouter.delete('/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647) {
        return res.status(400).json({ error: 'ID veicolo non valido.' });
    }
    let db;
    try {
        db = await pool.connect();
        await db.query('BEGIN');
        await db.query("SET LOCAL lock_timeout = '3s'");
        const { rows: [vehicle] } = await db.query(`
            SELECT id, image_url, stato FROM veicolo WHERE id = $1 AND driver_id = $2 FOR UPDATE
        `, [id, req.user.id]);
        if (!vehicle) {
            await db.query('ROLLBACK');
            return res.status(404).json({ error: 'Veicolo non trovato nella tua flotta.' });
        }

        if (vehicle.stato === 'eliminato') {
            await db.query('COMMIT');
            return res.json({ eliminato: true, archiviato: true });
        }

        const { rows: [active] } = await db.query(`
            SELECT EXISTS (SELECT 1 FROM corse WHERE veicolo_id = $1 AND (
                stato = 'in_corso' OR (stato IN ('prenotabile', 'accettata', 'da_attivare')
                AND coalesce(fine_ciclo_operativo, arrivo_datetime, start_datetime + durata, start_datetime) >= now())
            )) OR EXISTS (SELECT 1 FROM pending WHERE veicolo_id = $1 AND stato = 'pending' AND expires_at > now())
            OR EXISTS (SELECT 1 FROM popbus_attivazioni WHERE veicolo_id = $1
                AND stato IN ('in_attesa_autista', 'confermata') AND arrivo >= now())
            OR EXISTS (SELECT 1 FROM assegnazioni_conducenti WHERE veicolo_id = $1
                AND stato = 'assegnata' AND upper(intervallo_operativo) > now())
            OR EXISTS (SELECT 1 FROM direttrici_virtuali WHERE veicolo_id = $1
                AND stato IN ('in_formazione', 'in_attesa_autista', 'attivo', 'confermata'))
            OR EXISTS (SELECT 1 FROM popbus_riserve r JOIN corse c ON c.id = r.corsa_id
                WHERE c.veicolo_id = $1 AND r.stato = 'riservata' AND r.expires_at > now()) AS presente
        `, [id]);
        if (active.presente) {
            await db.query('ROLLBACK');
            return res.status(409).json({ error: 'Chiudi le corse, le richieste o le assegnazioni ancora attive, poi rimuovi il veicolo.' });
        }

        const { rows: [history] } = await db.query(`
            SELECT EXISTS (SELECT 1 FROM corse WHERE veicolo_id = $1)
                OR EXISTS (SELECT 1 FROM pending WHERE veicolo_id = $1)
                OR EXISTS (SELECT 1 FROM popbus_attivazioni WHERE veicolo_id = $1)
                OR EXISTS (SELECT 1 FROM assegnazioni_conducenti WHERE veicolo_id = $1)
                OR EXISTS (SELECT 1 FROM ar_accettazioni WHERE veicolo_id = $1)
                OR EXISTS (SELECT 1 FROM popbus_ar_accettazioni WHERE veicolo_id = $1)
                OR EXISTS (SELECT 1 FROM direttrici_virtuali WHERE veicolo_id = $1)
                OR EXISTS (SELECT 1 FROM recensioni WHERE veicolo_id = $1) AS presente
        `, [id]);
        // La coda esistente ritenta la pulizia della cache e dei file dopo il commit.
        await db.query(`
            INSERT INTO admin_rimozioni_file_utenti (utente_id, tipo, risorsa_id)
            SELECT $2::integer, 'disponibilita', id FROM disponibilita_veicolo WHERE veicolo_id = $1
            UNION ALL SELECT $2, 'veicolo', $1
            ON CONFLICT (utente_id, tipo, risorsa_id) DO NOTHING
        `, [id, req.user.id]);
        if (history.presente) {
            await db.query("UPDATE veicolo SET stato = 'eliminato' WHERE id = $1 AND driver_id = $2", [id, req.user.id]);
            await db.query('COMMIT');
            void processAccountRemovals().catch(error => console.error('Pulizia cache veicolo:', error.code || error.name));
            return res.json({ eliminato: true, archiviato: true });
        }
        await db.query(`
            INSERT INTO admin_rimozioni_file_utenti (utente_id, url)
            SELECT $2, url FROM (
                SELECT url FROM documenti_autista WHERE veicolo_id = $1
                UNION SELECT $3::text
            ) AS assets WHERE url ~* '^https?://'
            ON CONFLICT (utente_id, url) DO NOTHING
        `, [id, req.user.id, vehicle.image_url]);
        await db.query('DELETE FROM veicolo WHERE id = $1 AND driver_id = $2', [id, req.user.id]);
        await db.query('COMMIT');
    } catch (error) {
        if (db) await db.query('ROLLBACK').catch(() => {});
        if (['55P03', '23503', '40001', '40P01'].includes(error.code)) {
            return res.status(409).json({ error: 'Il veicolo o i dati collegati sono in uso. Riprova più tardi.' });
        }
        console.error('Eliminazione veicolo:', error.code || error.name);
        return res.status(500).json({ error: 'Impossibile eliminare il veicolo.' });
    } finally {
        if (db) db.release();
    }
    void processAccountRemovals().catch(error => console.error('Pulizia veicolo:', error.code || error.name));
    return res.json({ eliminato: true });
});
