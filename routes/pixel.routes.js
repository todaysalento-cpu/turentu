import { Router } from 'express';
import { pool } from '../db/db.js';
import { discoverPixelComuneCandidates } from '../services/pixel/pixel-stop-selection-comune.service.js';

const pixelRouter = Router();

function parseNodoId(raw) {
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) ? id : null;
}

/**
 * GET /api/pixel/fermate?nodo_id=4
 * Catalogo commerciale: esclusivamente fermate attive e verificate.
 * Contratto invariato per frontend e validazione booking.
 */
pixelRouter.get('/fermate', async (req, res) => {
    try {
        const nodoId = parseNodoId(req.query.nodo_id);
        if (nodoId === null) {
            return res.status(400).json({ success: false, error: 'nodo_id non valido' });
        }

        const { rows } = await pool.query(`
            SELECT fermata_id AS id, nome, indirizzo, lat, lon, tipi_veicolo_ammessi
            FROM public.pixel_fermate_per_nodo($1::BIGINT)
            ORDER BY nome, fermata_id
        `, [nodoId]);

        return res.status(200).json({
            success: true,
            nodo_id: nodoId,
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
        console.error('❌ [PIXEL] Errore caricamento fermate:', error);
        return res.status(500).json({
            success: false,
            error: 'Errore interno durante il caricamento delle fermate'
        });
    }
});

/**
 * GET /api/pixel/fermate-test?nodo_id=4
 * Discovery Google Places transitoria: solo per collaudo isolato.
 * Gli ID sono etichette temporanee, NON ID di pixel_fermate.
 * Questo endpoint NON abilita pagamenti o prenotazioni.
 */
pixelRouter.get('/fermate-test', async (req, res) => {
    // Richiede esplicita attivazione E Stripe test: nessuna esposizione in ambiente pagamenti reali.
    if (
        process.env.PIXEL_TEST_MODE !== 'true' ||
        !String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_')
    ) {
        return res.status(404).json({ success: false, error: 'Endpoint non disponibile' });
    }

    const nodoId = parseNodoId(req.query.nodo_id);
    if (nodoId === null) {
        return res.status(400).json({ success: false, error: 'nodo_id non valido' });
    }

    try {
        const { rows } = await pool.query(`
            SELECT id, codice_istat_comune
            FROM public.nodi_territoriali
            WHERE id = $1::BIGINT AND attivo = TRUE
            LIMIT 1
        `, [nodoId]);

        const nodo = rows[0];
        if (!nodo?.codice_istat_comune) {
            return res.status(404).json({ success: false, error: 'Nodo territoriale non disponibile' });
        }

        const result = await discoverPixelComuneCandidates(
            nodo.codice_istat_comune,
            { source: 'GOOGLE' }
        );

        if (result.stato !== 'ok') {
            console.warn('[PIXEL TEST] Discovery non completa:', result.stato, result.errori);
            return res.status(503).json({
                success: false,
                error: 'Discovery PIXEL temporaneamente non disponibile'
            });
        }

        const fermate = (result.selezionati || [])
            .filter(candidate =>
                (candidate.nodi_raggiungibili || []).some(id => String(id) === String(nodoId))
            )
            .map((candidate, index) => ({
                id: `test_${nodoId}_${index + 1}`,
                nome: candidate.nome,
                tipo: candidate.tipo,
                lat: Number(candidate.lat),
                lon: Number(candidate.lon),
                operativa_test: true,
                verificata: false,
                prenotabile: false
            }));

        console.log('[PIXEL TEST] Fermate temporanee:', {
            nodo_id: nodoId,
            fermate: fermate.length
        });

        return res.status(200).json({
            success: true,
            nodo_id: nodoId,
            modalita: 'test',
            persistite: false,
            prenotabili: false,
            fermate
        });
    } catch (error) {
        console.error('[PIXEL TEST] Errore fermate temporanee:', error);
        return res.status(500).json({
            success: false,
            error: 'Errore interno durante la discovery PIXEL test'
        });
    }
});

export default pixelRouter;
