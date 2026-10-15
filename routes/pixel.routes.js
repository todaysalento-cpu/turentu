
import { Router } from 'express';
import { pool } from '../db/db.js';

const pixelRouter = Router();

/**
 * GET /api/pixel/fermate?nodo_id=6
 *
 * Restituisce esclusivamente le fermate PIXEL
 * attive e verificate del nodo territoriale.
 */
pixelRouter.get('/fermate', async (req, res) => {
    try {
        const nodoIdRaw = req.query.nodo_id;

        if (
            typeof nodoIdRaw !== 'string' ||
            !/^[1-9]\d*$/.test(nodoIdRaw) ||
            !Number.isSafeInteger(Number(nodoIdRaw))
        ) {
            return res.status(400).json({
                success: false,
                error: 'nodo_id non valido'
            });
        }

        const nodoId = Number(nodoIdRaw);

        const { rows } = await pool.query(
            `
            SELECT
                fermata_id AS id,
                nome,
                indirizzo,
                lat,
                lon,
                tipi_veicolo_ammessi
            FROM public.pixel_fermate_per_nodo($1::BIGINT)
            ORDER BY nome, fermata_id
            `,
            [nodoId]
        );

        return res.status(200).json({
            success: true,
            nodo_id: nodoId,
            fermate: rows.map(row => ({
                id: Number(row.id),
                nome: row.nome,
                indirizzo: row.indirizzo,
                lat: Number(row.lat),
                lon: Number(row.lon),
                tipi_veicolo_ammessi:
                    row.tipi_veicolo_ammessi || []
            }))
        });

    } catch (error) {
        console.error(
            '❌ [PIXEL] Errore caricamento fermate:',
            error
        );

        return res.status(500).json({
            success: false,
            error: 'Errore interno durante il caricamento delle fermate'
        });
    }
});

export default pixelRouter;
