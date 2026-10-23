import { Router } from 'express';
import { pool } from '../db/db.js';
import { pixelCollaudoEnabled } from '../services/pixel/pixel-collaudo-mode.js';
import { ensurePixelStopsForNode } from '../services/pixel/pixel-stop-acquisition.service.js';

const pixelRouter = Router();

function parseNodoId(raw) {
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) ? id : null;
}

/** Catalogo fermate: commerciale in produzione, esteso in collaudo. */
pixelRouter.get('/fermate', async (req, res) => {
    try {
        const nodoId = parseNodoId(req.query.nodo_id);
        if (nodoId === null) {
            return res.status(400).json({ success: false, error: 'nodo_id non valido' });
        }

        const collaudo = pixelCollaudoEnabled();
        let rows;
        if (collaudo) {
            const read = () => pool.query(`
                SELECT f.id, f.nome, f.indirizzo,
                       ST_Y(f.posizione::geometry) AS lat,
                       ST_X(f.posizione::geometry) AS lon,
                       f.tipi_veicolo_ammessi
                FROM public.pixel_fermate f
                JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id
                WHERE f.nodo_territoriale_id = $1::bigint AND n.attivo = TRUE
                ORDER BY f.nome, f.id`, [nodoId]);
            ({ rows } = await read());
            if (!rows.length) {
                const acquisition = await ensurePixelStopsForNode(nodoId);
                console.log('[PIXEL COLLAUDO] Acquisizione:', { nodoId, ...acquisition });
                ({ rows } = await read());
            }
        } else {
            ({ rows } = await pool.query(`
                SELECT fermata_id AS id, nome, indirizzo, lat, lon, tipi_veicolo_ammessi
                FROM public.pixel_fermate_per_nodo($1::bigint)
                ORDER BY nome, fermata_id`, [nodoId]));
        }

        return res.status(200).json({
            success: true,
            nodo_id: nodoId,
            modalita: collaudo ? 'collaudo' : 'commerciale',
            fermate: rows.map(row => ({
                id: Number(row.id),
                nome: row.nome,
                indirizzo: row.indirizzo,
                lat: Number(row.lat),
                lon: Number(row.lon),
                tipi_veicolo_ammessi: row.tipi_veicolo_ammessi || []
            }))
        });
    } catch (error) {
        console.error('[PIXEL] Errore caricamento fermate:', error);
        return res.status(500).json({
            success: false,
            error: 'Errore interno durante il caricamento delle fermate'
        });
    }
});

/**
 * Catalogo per il frontend di collaudo.
 * Espone SOLO le fixture sintetiche esplicitamente tracciate dalla CLI,
 * con ID numerici persistenti; non usa Google Places e non scrive sul DB.
 */
pixelRouter.get('/fermate-test', async (req, res) => {
    if (!pixelCollaudoEnabled()) {
        return res.status(404).json({ success: false, error: 'Endpoint non disponibile' });
    }

    const nodoId = parseNodoId(req.query.nodo_id);
    if (nodoId === null) {
        return res.status(400).json({ success: false, error: 'nodo_id non valido' });
    }

    try {
        const { rows: nodes } = await pool.query(`
            SELECT id FROM public.nodi_territoriali
            WHERE id = $1::bigint AND attivo = TRUE
            LIMIT 1`, [nodoId]);

        if (!nodes.length) {
            return res.status(404).json({ success: false, error: 'Nodo territoriale non disponibile' });
        }

        const { rows } = await pool.query(`
            SELECT f.id, f.nome, f.indirizzo,
                   ST_Y(f.posizione::geometry) AS lat,
                   ST_X(f.posizione::geometry) AS lon,
                   f.tipi_veicolo_ammessi, f.verificata
            FROM public.pixel_fixture_stops x
            JOIN public.pixel_fermate f ON f.id = x.fermata_id
            WHERE f.nodo_territoriale_id = $1::bigint
              AND f.attiva = FALSE
              AND f.verificata = FALSE
            ORDER BY f.id`, [nodoId]);

        const fermate = rows.map(row => ({
            id: Number(row.id),
            nome: row.nome,
            indirizzo: row.indirizzo,
            lat: Number(row.lat),
            lon: Number(row.lon),
            tipi_veicolo_ammessi: row.tipi_veicolo_ammessi || [],
            operativa_test: true,
            verificata: false,
            prenotabile: true
        }));

        return res.status(200).json({
            success: true,
            nodo_id: nodoId,
            modalita: 'collaudo',
            persistite: true,
            prenotabili: true,
            fermate
        });
    } catch (error) {
        console.error('[PIXEL TEST] Errore lettura fixture:', error);
        return res.status(500).json({
            success: false,
            error: 'Errore interno durante il caricamento delle fermate di collaudo'
        });
    }
});

export default pixelRouter;