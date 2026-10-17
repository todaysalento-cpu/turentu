// ROUTE DIAGNOSTICA TEMPORANEA - SOLA LETTURA - RIMUOVERE DOPO IL TEST
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import ngeohash from 'ngeohash';
import polyline from '@mapbox/polyline';
import * as turf from '@turf/turf';
import { pool } from '../db/db.js';
import { redisClient } from '../redis.js';
import { CacheStore } from '../services/search/search.cache.js';

const router = Router();
const ORIGINE = { lat: 39.9051765, lon: 18.3644653 };
const DESTINAZIONE = { lat: 40.4674, lon: 17.2348 };
const ORARIO_RICHIESTO = '2026-11-03T13:00:00.000Z';
const POSTI_RICHIESTI = 1;
const TRATTA_TEST = 3;

function snapDiagnostico(line, lat, lon) {
    const snap = turf.nearestPointOnLine(line, turf.point([lon, lat]), { units: 'kilometers' });
    return {
        distanza_km: Number(snap.properties.dist.toFixed(5)),
        offset_metri: Number((snap.properties.location * 1000).toFixed(2)),
        indice_polyline: snap.properties.index,
        entro_tolleranza_3km: snap.properties.dist <= 3
    };
}

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

        const hashOrigine = ngeohash.encode(ORIGINE.lat, ORIGINE.lon, 5);
        const celleRicerca = [hashOrigine, ...ngeohash.neighbors(hashOrigine)];
        const perCella = await Promise.all(celleRicerca.map(async hash => ({
            geohash: hash,
            contiene_tratta_3: await redisClient.sIsMember(`tratta:in_area:${hash}`, String(TRATTA_TEST))
        })));
        const idsPerCella = await Promise.all(celleRicerca.map(h => redisClient.sMembers(`tratta:in_area:${h}`)));
        const candidatiRedis = [...new Set(idsPerCella.flat().map(Number))];
        const tratta = CacheStore.tratteCache.get(TRATTA_TEST);
        const corsa = tratta ? CacheStore.corseCache.get(Number(tratta.corsa_id)) : null;
        const filtroPreliminare = {
            tratta_in_redis: candidatiRedis.includes(TRATTA_TEST),
            tratta_in_cache: Boolean(tratta),
            stato_temporale_ammesso: Boolean(tratta && tratta.stato_temporale !== 'flessibile'),
            partenza_prevista_presente: Boolean(tratta?.partenza_prevista),
            corsa_in_cache: Boolean(corsa),
            tipo_corsa_condivisa: corsa?.tipo_corsa === 'condivisa',
            corsa_prenotabile: corsa?.stato === 'prenotabile'
        };
        const passaFiltroPreliminare = Object.values(filtroPreliminare).every(Boolean);

        const { rows: datiDb } = await pool.query(`
            SELECT c.id AS corsa_id, c.veicolo_id, v.posti_totali,
                   t.distanza_km, t.durata_secondi, t.partenza_prevista,
                   t.percorso_polyline
            FROM public.corse_tratte t
            JOIN public.corse c ON c.id = t.corsa_id
            LEFT JOIN public.veicolo v ON v.id = c.veicolo_id
            WHERE t.id = $1
        `, [TRATTA_TEST]);
        const db = datiDb[0] ?? null;
        const { rows: prenotazioni } = await pool.query(`
            SELECT id, tratta_id, posti_richiesti, start_offset, end_offset
            FROM public.prenotazioni WHERE corsa_id = $1
        `, [899]);

        let geometria = null;
        let geometriaErrore = null;
        if (tratta?.percorso_polyline || db?.percorso_polyline) {
            try {
                const decoded = polyline.decode(tratta?.percorso_polyline || db.percorso_polyline);
                const line = turf.lineString(decoded.map(([lat, lon]) => [lon, lat]));
                const start = snapDiagnostico(line, ORIGINE.lat, ORIGINE.lon);
                const end = snapDiagnostico(line, DESTINAZIONE.lat, DESTINAZIONE.lon);
                const kmUtente = (end.offset_metri - start.offset_metri) / 1000;
                const kmMissione = Number(tratta?.distanza_km ?? db?.distanza_km);
                const quotaMinima = kmMissione <= 30 ? .70 : kmMissione <= 100 ? .60 : kmMissione <= 300 ? .50 : .40;
                const lunghezzaTotaleMetri = Number(tratta?.distanza_km ?? db?.distanza_km) * 1000;
                const durataSecondi = Number(tratta?.durata_secondi ?? db?.durata_secondi);
                const partenza = tratta?.partenza_prevista ?? db?.partenza_prevista;
                const timestampSalita = new Date(partenza).getTime() + (start.offset_metri > 0 && lunghezzaTotaleMetri > 0 ? durataSecondi * 1000 * Math.min(1, start.offset_metri / lunghezzaTotaleMetri) : 0);
                const differenzaMinuti = (timestampSalita - new Date(ORARIO_RICHIESTO).getTime()) / 60000;
                geometria = {
                    punti: decoded.length,
                    primo_punto_geohash: ngeohash.encode(decoded[0][0], decoded[0][1], 5),
                    start,
                    end,
                    km_utente: Number(kmUtente.toFixed(3)),
                    km_missione: kmMissione,
                    quota_minima: quotaMinima,
                    rapporto_percorso: Number((kmUtente / kmMissione).toFixed(4)),
                    snap_ammessi: start.entro_tolleranza_3km && end.entro_tolleranza_3km,
                    ordine_e_lunghezza_ammessi: end.offset_metri - start.offset_metri >= 500,
                    quota_percorso_ammessa: Number.isFinite(kmMissione) && kmMissione > 0 && kmUtente / kmMissione >= quotaMinima,
                    partenza_stimata_al_punto_salita: Number.isFinite(timestampSalita) ? new Date(timestampSalita).toISOString() : null,
                    differenza_oraria_minuti: Number.isFinite(differenzaMinuti) ? Number(differenzaMinuti.toFixed(2)) : null,
                    orario_entro_30_minuti: Number.isFinite(differenzaMinuti) && Math.abs(differenzaMinuti) <= 30
                };
            } catch (err) {
                geometriaErrore = err.message;
            }
        }

        return res.json({
            ok: true,
            risultati,
            diagnostica_899_tratta_3: {
                origine: ORIGINE,
                destinazione: DESTINAZIONE,
                orario_richiesto: ORARIO_RICHIESTO,
                hash_origine: hashOrigine,
                celle_ricerca: perCella,
                tratta_3_tra_candidati_redis: candidatiRedis.includes(TRATTA_TEST),
                filtro_preliminare: filtroPreliminare,
                passa_filtro_preliminare: passaFiltroPreliminare,
                capacita_veicolo_db: db?.posti_totali == null ? null : Number(db.posti_totali),
                prenotazioni_totali: prenotazioni.length,
                prenotazioni_senza_tratta_id: prenotazioni.filter(p => p.tratta_id == null).length,
                geometria,
                geometria_errore: geometriaErrore,
                nota: 'Diagnostica indipendente: non esegue filterDisponibilita e non prova il risultato finale dell’API search.'
            }
        });
    } catch (error) {
        console.error('[DIAGNOSTICA TRATTE REDIS]', error);
        return res.status(500).json({ ok: false, error: 'Errore diagnostica; consultare i log' });
    }
});

export default router;
