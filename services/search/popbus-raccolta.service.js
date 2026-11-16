import { readFile } from 'node:fs/promises';
import { haversineDistance } from '../../utils/geo.util.js';
import { getDurataDistanza, getRouteGeometry } from '../../utils/maps.util.js';
import { classePercorrenza, QUALITA_PERCORRENZA } from '../popbus/v2/model.js';
import { dettaglioFermataGoogle } from '../popbus/v2/popbus-stop-candidates.service.js';

const RAGGIO_PERCORSO_METRI = 3000;
const RAGGIO_ALTERNATIVE_METRI = 20000;
const MAX_ACCESSO_MS = 12 * 60000;
const MAX_ACCESSO_ALTERNATIVO_MS = 30 * 60000;
const MAX_COMUNI = 8;

let comuniPromise;
async function caricaComuni() {
    const [popolazione, coordinate] = await Promise.all([
        readFile(new URL('../../data/ISTAT/ASL_comuni_popolazione_2024.csv', import.meta.url), 'utf8'),
        readFile(new URL('../../data/ISTAT/comuni-coordinate.csv', import.meta.url), 'utf8')
    ]);
    const [header, ...righe] = popolazione.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    const colonne = header.split(';');
    const codice = colonne.indexOf('CODICE COMUNE');
    const totale = colonne.indexOf('TOTALE');
    const residenti = new Map(righe.map(riga => {
        const valori = riga.split(';');
        return [valori[codice]?.trim(), Number(valori[totale]?.trim().replaceAll('.', ''))];
    }));

    const comuni = new Map([...residenti].filter(([id]) => /^\d{6}$/.test(id))
        .map(([codice, popolazione]) => [codice, { codice, popolazione }]));
    for (const riga of coordinate.split(/\r?\n/)) {
        const [id, lat, lon] = riga.split(',');
        if (!/^\d{6}$/.test(id) || !lat || !lon) continue;
        comuni.set(id, { codice: id, popolazione: residenti.get(id) || 0, lat: Number(lat), lon: Number(lon) });
    }
    return comuni;
}

export function comuniRaccolta() {
    comuniPromise ??= caricaComuni().catch(error => {
        comuniPromise = null;
        throw error;
    });
    return comuniPromise;
}

export const percorrenzaConRaccolta = km => ['MEDIA', 'LUNGA'].includes(classePercorrenza({}, km));

export async function cercaSalitaLocalePrimaDellAlternativa({
    raccolta, destinazioneNodoId, risolviOrigine, assegnaLocale, acquisisci
}) {
    if (!raccolta?.fuori_copertura || raccolta.capoluogo_frazione) return null;
    const origine = await risolviOrigine();
    if (!origine?.id || Number(origine.id) === Number(destinazioneNodoId) ||
        Number(origine.id) === Number(raccolta.nodo_id)) return null;

    let fermate = await assegnaLocale(origine);
    if (!fermate.salita) {
        const esito = await acquisisci(origine);
        if (esito.aggiornata) fermate = await assegnaLocale(origine);
    }
    return fermate.salita ? { origine, fermate } : null;
}

async function cercaFermate(pool, polyline, origine, codiceDestinazione, {
    alternative = false, scadenzaMinima = null, capoluogo = null
} = {}) {
    const riferimento = alternative ? 'p.partenza' : 'p.tracciato';
    const raggio = alternative ? RAGGIO_ALTERNATIVE_METRI : RAGGIO_PERCORSO_METRI;
    const { rows } = await pool.query(`
        WITH percorso AS (
            SELECT ST_LineFromEncodedPolyline($1)::geography AS tracciato,
                   ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography AS partenza
        ),
        fermate AS (
            SELECT DISTINCT ON (n.codice_istat_comune)
                   n.id AS nodo_id, n.codice_istat_comune AS codice, d.popolazione,
                   btrim(split_part(n.nome, ',', 1)) AS localita,
                   f.id AS fermata_id, f.nome AS fermata, f.google_place_id,
                   ST_Y(f.posizione::geometry) AS lat, ST_X(f.posizione::geometry) AS lon,
                   ST_Distance(f.posizione::geography, p.partenza) AS distanza_partenza
            FROM percorso p
            JOIN public.pixel_fermate f ON f.attiva
                AND (f.google_place_id IS NULL OR ($7::timestamptz IS NOT NULL
                     AND f.google_geo_scade_il > GREATEST(NOW(), $7)))
                AND ST_DWithin(f.posizione::geography, ${riferimento}, $5)
            JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id AND n.attivo
            LEFT JOIN public.pixel_demografia d ON d.nodo_territoriale_id = n.id
            WHERE n.codice_istat_comune <> $4
              AND ($8::text IS NULL OR (n.codice_istat_comune = $8
                   AND lower(btrim(split_part(n.nome, ',', 1))) = lower($9::text)))
              AND upper(ltrim(f.nome)) NOT LIKE 'TEST PIXEL%'
              AND upper(ltrim(f.nome)) NOT LIKE '[TEST PIXEL]%'
              AND NOT EXISTS (
                  SELECT 1 FROM public.pixel_fermate_test_metadata t WHERE t.fermata_id = f.id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM public.pixel_fermate_fonti ff
                  WHERE ff.fermata_id = f.id AND ff.stato_verifica = 'non_ammessa'
              )
            ORDER BY n.codice_istat_comune, distanza_partenza,
                     ST_Distance(f.posizione::geography, p.tracciato), f.id
        )
        SELECT * FROM fermate ORDER BY distanza_partenza, fermata_id LIMIT $6
    `, [polyline, origine.lon, origine.lat, codiceDestinazione, raggio, MAX_COMUNI, scadenzaMinima,
        capoluogo?.codice ?? null, capoluogo?.nome ?? null]);
    return rows;
}

async function cercaCentriSulPercorso(pool, polyline, origine, codiceDestinazione, comuni) {
    const vicini = [...comuni.values()].filter(c =>
        Number.isFinite(c.lat) && haversineDistance(origine, c) <= RAGGIO_ALTERNATIVE_METRI / 1000
    );
    const { rows } = await pool.query(`
        WITH percorso AS (
            SELECT ST_LineFromEncodedPolyline($1)::geography AS tracciato,
                   ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography AS partenza
        ), centri_istat AS (
            SELECT codice, ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography AS posizione
            FROM jsonb_to_recordset($4::jsonb) AS c(codice text, lat float8, lon float8)
        ), centri AS (
            SELECT codice, posizione FROM centri_istat
            UNION ALL
            SELECT n.codice_istat_comune, n.posizione::geography
            FROM public.nodi_territoriali n CROSS JOIN percorso p
            WHERE n.attivo AND ST_DWithin(n.posizione::geography, p.partenza, $5)
              AND NOT EXISTS (SELECT 1 FROM centri_istat c WHERE c.codice = n.codice_istat_comune)
        )
        SELECT DISTINCT ON (c.codice) c.codice,
            ST_Y(c.posizione::geometry) AS lat, ST_X(c.posizione::geometry) AS lon,
            ST_Distance(c.posizione, p.partenza) AS distanza_partenza
        FROM centri c CROSS JOIN percorso p
        WHERE c.codice ~ '^[0-9]{6}$' AND c.codice <> $6
          AND ST_DWithin(c.posizione, p.tracciato, $7)
        ORDER BY c.codice, distanza_partenza, lat, lon
    `, [polyline, origine.lon, origine.lat, JSON.stringify(vicini), RAGGIO_ALTERNATIVE_METRI,
        codiceDestinazione, RAGGIO_PERCORSO_METRI]);
    return rows.map(centro => ({ ...centro, popolazione: comuni.get(centro.codice)?.popolazione ?? null }))
        .sort((a, b) => (b.popolazione ?? 0) - (a.popolazione ?? 0) ||
        a.distanza_partenza - b.distanza_partenza || a.codice.localeCompare(b.codice)).slice(0, MAX_COMUNI);
}

export async function scegliRaccoltaPopbus({
    pool, origine, destinazione, codiceOrigine, codiceDestinazione, distanzaKm,
    route = getDurataDistanza, geometria = getRouteGeometry, caricaTerritorio = comuniRaccolta,
    censisciCentro, scadenzaMinima = null, localitaOrigine, comuneOrigine
}) {
    if (!percorrenzaConRaccolta(distanzaKm) ||
        !/^\d{6}$/.test(codiceOrigine) || !/^\d{6}$/.test(codiceDestinazione) ||
        codiceOrigine === codiceDestinazione) return null;

    const [percorso, comuni] = await Promise.all([
        geometria(origine, destinazione, { shortest: true }),
        caricaTerritorio()
    ]);
    const classe = classePercorrenza({}, percorso.distanzaKm);
    if (!classe || classe === 'BASSA' || !percorso.polyline) return null;

    const cercaAccessi = async fermate => (await Promise.all(fermate.map(async fermata => {
        const coincide = haversineDistance(origine, fermata) <= 0.01;
        const info = coincide ? { distanzaKm: 0, durataMs: 0 } : await route(origine, fermata);
        if (!coincide && !(info.distanzaKm > 0 && info.durataMs > 0)) return null;
        const popolazione = comuni.get(fermata.codice)?.popolazione || Number(fermata.popolazione) || 0;
        return { fermata, info, popolazione };
    }))).filter(Boolean);

    const fermate = await cercaFermate(pool, percorso.polyline, origine, codiceDestinazione, { scadenzaMinima });
    const accessi = await cercaAccessi(fermate);
    const perVicinanza = (a, b) => a.info.durataMs - b.info.durataMs ||
        a.info.distanzaKm - b.info.distanzaKm || Number(a.fermata.fermata_id) - Number(b.fermata.fermata_id);
    const preferite = accessi.filter(a => a.info.durataMs <= MAX_ACCESSO_MS)
        .sort((a, b) => b.popolazione - a.popolazione || perVicinanza(a, b));
    const maxKm = percorso.distanzaKm * (1 + QUALITA_PERCORRENZA[classe].maxDeviazionePct / 100);
    const esaminate = new Map();

    async function valuta({ fermata, info }) {
        if (esaminate.has(fermata.fermata_id)) return esaminate.get(fermata.fermata_id);
        const tratta = await route(fermata, destinazione);
        const valida = tratta.distanzaKm > 0 && tratta.durataMs > 0;
        const risultato = valida ? {
            nodo_id: Number(fermata.nodo_id),
            fermata_id: Number(fermata.fermata_id),
            localita: fermata.localita,
            nome: fermata.fermata,
            lat: fermata.lat,
            lon: fermata.lon,
            accesso_minuti: Math.ceil(info.durataMs / 60000),
            tratta_km: tratta.distanzaKm,
            tratta_minuti: tratta.durataMs / 60000,
            ...dettaglioFermataGoogle(fermata.google_place_id),
            fuori_copertura: info.durataMs > MAX_ACCESSO_MS ||
                info.distanzaKm + tratta.distanzaKm > maxKm
        } : null;
        esaminate.set(fermata.fermata_id, risultato);
        return risultato;
    }

    let ordinaria = null;
    for (const accesso of preferite) {
        const opzione = await valuta(accesso);
        if (opzione && !opzione.fuori_copertura) {
            ordinaria = { opzione, popolazione: accesso.popolazione, codice: accesso.fermata.codice };
            break;
        }
    }

    if (censisciCentro) {
        try {
            const centri = await cercaCentriSulPercorso(pool, percorso.polyline, origine, codiceDestinazione, comuni);
            const conFermate = new Set(fermate.map(f => f.codice));
            const maxAccesso = ordinaria ? MAX_ACCESSO_MS : MAX_ACCESSO_ALTERNATIVO_MS;
            for (const centro of centri) {
                if (ordinaria && (centro.popolazione ?? 0) <= ordinaria.popolazione) break;
                const coincide = haversineDistance(origine, centro) <= 0.01;
                const accesso = coincide ? { distanzaKm: 0, durataMs: 0 } : await route(origine, centro);
                if ((!coincide && !(accesso.distanzaKm > 0 && accesso.durataMs > 0)) ||
                    accesso.durataMs > maxAccesso) continue;
                const tratta = await route(centro, destinazione);
                if (!(tratta.distanzaKm > 0 && tratta.durataMs > 0) ||
                    accesso.distanzaKm + tratta.distanzaKm > maxKm) continue;
                if (!conFermate.has(centro.codice)) {
                    await censisciCentro(centro, { polyline: percorso.polyline, raggioMetri: RAGGIO_PERCORSO_METRI });
                }
                break;
            }
        } catch (error) {
            console.warn('[POPBUS SEARCH] Censimento fermate non riuscito:', error.message);
        }
    }
    const normalizza = nome => nome?.trim().toLocaleLowerCase('it-IT');
    const comune = normalizza(comuneOrigine);
    const parteDaFrazione = comune && localitaOrigine && normalizza(localitaOrigine) !== comune;
    if (parteDaFrazione && (!ordinaria ||
        (ordinaria.codice === codiceOrigine && normalizza(ordinaria.opzione.localita) !== comune))) {
        const capoluogo = await cercaFermate(pool, percorso.polyline, origine, codiceDestinazione, {
            alternative: true, scadenzaMinima, capoluogo: { codice: codiceOrigine, nome: comuneOrigine.trim() }
        });
        for (const accesso of await cercaAccessi(capoluogo)) {
            if (accesso.info.durataMs > MAX_ACCESSO_ALTERNATIVO_MS) continue;
            const opzione = await valuta(accesso);
            if (opzione && accesso.info.distanzaKm + opzione.tratta_km <= maxKm) {
                return { ...opzione, fuori_copertura: true, capoluogo_frazione: true };
            }
        }
    }
    if (ordinaria) return ordinaria.opzione;

    const fermateNote = new Set(fermate.map(f => f.fermata_id));
    const alternative = await cercaFermate(pool, percorso.polyline, origine, codiceDestinazione, {
        alternative: true, scadenzaMinima
    });
    const accessiAlternativi = await cercaAccessi(alternative.filter(f => !fermateNote.has(f.fermata_id)));
    const piuVicine = [...accessi, ...accessiAlternativi]
        .filter(({ info }) => info.durataMs <= MAX_ACCESSO_ALTERNATIVO_MS)
        .sort(perVicinanza);
    for (const accesso of piuVicine) {
        const opzione = await valuta(accesso);
        if (opzione && (!opzione.provvisoria || accesso.info.distanzaKm + opzione.tratta_km <= maxKm)) {
            return { ...opzione, fuori_copertura: true };
        }
    }
    return null;
}
