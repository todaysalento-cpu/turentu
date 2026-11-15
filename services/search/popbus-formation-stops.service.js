import { haversineDistance } from '../../utils/geo.util.js';
import { TOLLERANZA_MS } from '../popbus/v2/model.js';
import { DEFAULT_RADIUS_METERS } from '../popbus/v2/popbus-stop-candidates.service.js';

const validPoint = ({ lat, lon }) =>
    Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    Number.isFinite(lon) && Math.abs(lon) <= 180;

export async function cercaFermateFormazionePopbus({
    pool, origine, destinazione, origineNodoId, destinazioneNodoId,
    partenzaRichiesta, postiRichiesti, now = Date.now()
}) {
    const partenza = partenzaRichiesta.getTime();
    if (!Number.isFinite(partenza) || !validPoint(origine) || !validPoint(destinazione) ||
        ![origineNodoId, destinazioneNodoId, postiRichiesti].every(n => Number.isSafeInteger(n) && n > 0) ||
        origineNodoId === destinazioneNodoId) return null;

    const { rows } = await pool.query(`
        SELECT a.piano->'coordinates' AS coordinate,
               a.piano->'evaluation'->'times' AS tempi,
               a.piano->'validazioneCapienza'->'occupazioneSegmenti' AS occupazione,
               v.posti_totali,
               a.partenza AS partenza_ciclo,
               a.piano->'missioni'->(m.ordine::integer - 1) AS missione,
               fermate.elenco AS fermate
        FROM public.popbus_attivazione_missioni m
        JOIN public.popbus_attivazioni a ON a.id = m.attivazione_id
        JOIN public.veicolo v ON v.id = a.veicolo_id
        JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object(
                'id', f.id, 'nome', f.nome, 'nodo_id', f.nodo_territoriale_id
            )) AS elenco
            FROM jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(m.piano->'nodes') = 'array'
                     THEN m.piano->'nodes' ELSE '[]'::jsonb END
            ) AS visita(id)
            JOIN public.pixel_fermate f ON f.id = visita.id::bigint
            WHERE f.attiva
              AND f.nodo_territoriale_id IN ($1, $2)
              AND f.nome !~* '^[[:space:]]*(\\[TEST PIXEL\\]|TEST PIXEL([[:space:]]|$))'
              AND NOT EXISTS (
                  SELECT 1 FROM public.pixel_fermate_test_metadata t WHERE t.fermata_id = f.id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM public.pixel_fermate_fonti ff
                  WHERE ff.fermata_id = f.id AND ff.stato_verifica = 'non_ammessa'
              )
        ) fermate ON fermate.elenco IS NOT NULL
        WHERE a.stato = 'in_attesa_autista' AND a.expires_at > NOW()
          AND a.partenza <= $3 AND a.arrivo >= $4
          AND m.partenza <= $3 AND m.arrivo >= $4
          AND m.pixel_opportunita_id IS NOT NULL
          AND m.nodi_territoriali @> ARRAY[$1::bigint, $2::bigint]
          AND a.piano->>'schemaVersion' = '2'
          AND a.piano->>'tipoItinerario' = 'FERMATE_FISICHE'
        ORDER BY a.id, m.ordine
    `, [
        origineNodoId, destinazioneNodoId,
        new Date(partenza + TOLLERANZA_MS), new Date(Math.max(now, partenza - TOLLERANZA_MS))
    ]);

    let migliore = null;

    for (const row of rows) {
        const { startIndex, endIndex } = row.missione ?? {};
        const { coordinate, tempi, occupazione } = row;
        if (!Array.isArray(coordinate) || !Array.isArray(tempi) || !Array.isArray(occupazione) ||
            !Number.isSafeInteger(startIndex) || !Number.isSafeInteger(endIndex) ||
            startIndex < 0 || endIndex <= startIndex || endIndex >= coordinate.length ||
            endIndex >= tempi.length || endIndex > occupazione.length) continue;

        const inizio = new Date(row.partenza_ciclo).getTime();
        const fermate = new Map(row.fermate.map(f => [f.id, f]));
        const visite = coordinate.slice(startIndex, endIndex + 1).map((p, i) => {
            const fermata = fermate.get(p.id);
            const indice = startIndex + i;
            if (!fermata?.nome || !validPoint(p) || !Number.isFinite(tempi[indice])) return null;
            const puntoUtente = fermata.nodo_id === origineNodoId ? origine : destinazione;
            const distanza = haversineDistance(p, puntoUtente) * 1000;
            return distanza <= DEFAULT_RADIUS_METERS
                ? { fermata, indice, orario: inizio + tempi[indice], distanza }
                : null;
        }).filter(Boolean);

        for (const salita of visite) {
            const scarto = Math.abs(salita.orario - partenza);
            if (salita.fermata.nodo_id !== origineNodoId || !Number.isFinite(scarto) ||
                salita.orario < now || scarto > TOLLERANZA_MS) continue;

            for (const discesa of visite) {
                if (discesa.fermata.nodo_id !== destinazioneNodoId ||
                    discesa.indice <= salita.indice || discesa.orario <= salita.orario) continue;

                const postiLiberi = Number(row.posti_totali) -
                    Math.max(...occupazione.slice(salita.indice, discesa.indice));
                if (!Number.isFinite(postiLiberi) || postiLiberi < postiRichiesti) continue;

                const precede = !migliore ||
                    salita.distanza < migliore.salita.distanza ||
                    (salita.distanza === migliore.salita.distanza &&
                        (discesa.distanza < migliore.discesa.distanza ||
                            (discesa.distanza === migliore.discesa.distanza && scarto < migliore.scarto)));
                if (precede) migliore = { salita, discesa, scarto };
            }
        }
    }

    if (!migliore) return null;

    const dettaglio = ({ fermata, distanza }) => ({
        nome: fermata.nome,
        distanza_metri: Math.round(distanza)
    });
    return { salita: dettaglio(migliore.salita), discesa: dettaglio(migliore.discesa) };
}
