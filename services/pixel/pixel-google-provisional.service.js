import { pixelDistanceMeters } from './pixel-stop-discovery.service.js';
import { pool } from '../../db/db.js';

const RISERVA_CORSA_MS = 12 * 60 * 60 * 1000;

export function scadenzaUtileGoogle(partenza) {
    const ms = new Date(partenza).getTime();
    if (!Number.isFinite(ms)) throw new Error('Orario POPBUS non valido');
    return new Date(ms + RISERVA_CORSA_MS);
}

async function posizioneGoogle(placeId, { apiKey, fetchImpl }) {
    const response = await fetchImpl('https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId), {
        headers: {
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'location,businessStatus'
        },
        signal: AbortSignal.timeout(4500)
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Google Place Details HTTP ' + response.status);
    const data = await response.json();
    const lat = data.location?.latitude;
    const lon = data.location?.longitude;
    if (data.businessStatus?.startsWith('CLOSED_') || !Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { placeId, lat, lon };
}

export async function preparaFermataGoogleProvvisoria(nodo, punto, {
    database = pool, apiKey = process.env.GOOGLE_MAPS_API_KEY, fetchImpl = globalThis.fetch,
    raggioMetri, scadenzaMinima
}) {
    if (!apiKey || !(scadenzaMinima instanceof Date) ||
        scadenzaMinima.getTime() >= Date.now() + 7 * 86400000) return false;
    const candidati = await database.query(`
        SELECT c.place_id FROM public.pixel_candidati_google c
        JOIN public.nodi_territoriali n ON n.id = c.nodo_territoriale_id AND n.attivo
        WHERE c.nodo_territoriale_id = $1
        ORDER BY c.rilevato_il DESC, c.place_id LIMIT 8
    `, [nodo.id]);
    const risultati = await Promise.allSettled(candidati.rows.map(({ place_id }) =>
        posizioneGoogle(place_id, { apiKey, fetchImpl })));
    if (risultati.length && risultati.every(r => r.status === 'rejected')) throw risultati[0].reason;
    const compatibili = risultati.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : [])
        .map(f => ({ ...f, metri: pixelDistanceMeters(punto, f) }))
        .filter(f => f.metri <= raggioMetri)
        .sort((a, b) => a.metri - b.metri || a.placeId.localeCompare(b.placeId));
    const fermata = compatibili[0];
    if (!fermata) return false;

    const result = await database.query(`
        INSERT INTO public.pixel_fermate AS f
            (nodo_territoriale_id, nome, posizione, verificata, attiva, google_place_id, google_geo_scade_il)
        SELECT n.id, 'Punto di raccolta POPBUS · ' || left(split_part(n.nome, ',', 1), 120),
            ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, FALSE, TRUE, $4, NOW() + interval '7 days'
        FROM public.nodi_territoriali n WHERE n.id = $1 AND n.attivo
        ON CONFLICT (nodo_territoriale_id, google_place_id) WHERE google_place_id IS NOT NULL
        DO UPDATE SET posizione = EXCLUDED.posizione, google_geo_scade_il = EXCLUDED.google_geo_scade_il,
            attiva = TRUE, updated_at = NOW()
        WHERE (f.google_geo_scade_il IS NULL OR (f.attiva AND f.google_geo_scade_il <= $5))
          AND NOT EXISTS (
            SELECT 1 FROM public.pixel_fermate_fonti ff
            WHERE ff.fermata_id = f.id AND ff.stato_verifica = 'non_ammessa'
          )
    `, [nodo.id, fermata.lon, fermata.lat, fermata.placeId, scadenzaMinima]);
    return result.rowCount > 0;
}

export async function avviaScadenzaGeometrieGoogle(database = pool) {
    const { rows } = await database.query("SELECT to_regprocedure('public.elimina_geometrie_google_popbus()') IS NOT NULL AS pronta");
    if (!rows[0].pronta) return;
    const elimina = () => database.query('SELECT public.elimina_geometrie_google_popbus()');
    await elimina();
    let inCorso = false;
    const timer = setInterval(async () => {
        if (inCorso) return;
        inCorso = true;
        try { await elimina(); }
        catch (error) { console.error('[POPBUS] Pulizia geometrie Google non riuscita:', error.code ?? error.name); }
        finally { inCorso = false; }
    }, 15 * 60000);
    timer.unref();
}
