// ROUTE DIAGNOSTICA TEMPORANEA - RIMUOVERE DOPO IL TEST
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { pool } from '../db/db.js';
import { redisClient } from '../redis.js';
import { CacheStore } from '../services/search/search.cache.js';

const router = Router();

router.get('/diagnostica-tratte-redis', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const expected = process.env.DIAGNOSTIC_TOKEN;
    const received = req.get('x-diagnostic-token');
    if (!expected || !received || expected.length < 24) {
        return res.status(404).json({ error: 'Non disponibile' });
    }
    const a = Buffer.from(received, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return res.status(403).json({ error: 'Non autorizzato' });
    }

    try {
        const { rows } = await pool.query(`
            SELECT t.id, t.corsa_id, t.direzione, t.stato_temporale
            FROM public.corse_tratte t
            WHERE t.corsa_id = ANY($1::int[])
            ORDER BY t.corsa_id, t.direzione
        `, [[866, 899]]);

        const risultati = [];
        for (const t of rows) {
            const key = `tratta:hashes:${t.id}`;
            const raw = await redisClient.get(key);
            let hashes = [];
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) hashes = parsed.filter(h => typeof h === 'string');
                } catch { /* indice non valido */ }
            }
            let validi = 0;
            for (const hash of hashes) {
                if (await redisClient.sIsMember(`tratta:in_area:${hash}`, String(t.id))) validi++;
            }
            const cached = CacheStore.tratteCache.get(Number(t.id));
            risultati.push({
                corsa_id: Number(t.corsa_id),
                tratta_id: Number(t.id),
                direzione: t.direzione,
                stato_temporale: t.stato_temporale,
                presente_in_cache: Boolean(cached),
                punti_polyline_cache: cached?.decodedCoords?.length ?? 0,
                chiave_redis_presente: raw !== null,
                geohash_indicizzati: hashes.length,
                riferimenti_validi: validi,
                indice_coerente: hashes.length > 0 && validi === hashes.length
            });
        }
        return res.json({ ok: true, risultati });
    } catch (error) {
        console.error('[DIAGNOSTICA TRATTE REDIS]', error);
        return res.status(500).json({ ok: false, error: 'Errore diagnostica; consultare i log' });
    }
});

export default router;
