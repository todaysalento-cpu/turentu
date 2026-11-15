import { readFile } from 'node:fs/promises';
import { haversineDistance } from '../../utils/geo.util.js';
import { getDurataDistanza, getRouteGeometry } from '../../utils/maps.util.js';
import { classePercorrenza, QUALITA_PERCORRENZA } from '../popbus/v2/model.js';

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

    return new Map(coordinate.split(/\r?\n/).flatMap(riga => {
        const [id, lat, lon] = riga.split(',');
        if (!/^\d{6}$/.test(id) || !lat || !lon) return [];
        return [[id, { codice: id, lat: Number(lat), lon: Number(lon), popolazione: residenti.get(id) || 0 }]];
    }));
}

export function comuniRaccolta() {
    comuniPromise ??= caricaComuni().catch(error => {
        comuniPromise = null;
        throw error;
    });
    return comuniPromise;
}

export const percorrenzaConRaccolta = km => ['MEDIA', 'LUNGA'].includes(classePercorrenza({}, km));

async function cercaFermate(pool, polyline, origine, codiceDestinazione, alternative = false) {
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
                   f.id AS fermata_id, f.nome AS fermata,
                   ST_Y(f.posizione::geometry) AS lat, ST_X(f.posizione::geometry) AS lon,
                   ST_Distance(f.posizione::geography, p.partenza) AS distanza_partenza
            FROM percorso p
            JOIN public.pixel_fermate f ON f.attiva
                AND ST_DWithin(f.posizione::geography, ${riferimento}, $5)
            JOIN public.nodi_territoriali n ON n.id = f.nodo_territoriale_id AND n.attivo
            LEFT JOIN public.pixel_demografia d ON d.nodo_territoriale_id = n.id
            WHERE n.codice_istat_comune <> $4
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
    `, [polyline, origine.lon, origine.lat, codiceDestinazione, raggio, MAX_COMUNI]);
    return rows;
}

export async function scegliRaccoltaPopbus({
    pool, origine, destinazione, codiceOrigine, codiceDestinazione, distanzaKm,
    route = getDurataDistanza, geometria = getRouteGeometry, caricaTerritorio = comuniRaccolta
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
        const popolazione = Number(fermata.popolazione) || comuni.get(fermata.codice)?.popolazione || 0;
        return { fermata, info, popolazione };
    }))).filter(Boolean);

    const fermate = await cercaFermate(pool, percorso.polyline, origine, codiceDestinazione);
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
            fuori_copertura: info.durataMs > MAX_ACCESSO_MS ||
                info.distanzaKm + tratta.distanzaKm > maxKm
        } : null;
        esaminate.set(fermata.fermata_id, risultato);
        return risultato;
    }

    for (const accesso of preferite) {
        const opzione = await valuta(accesso);
        if (opzione && !opzione.fuori_copertura) return opzione;
    }

    const fermateNote = new Set(fermate.map(f => f.fermata_id));
    const alternative = await cercaFermate(pool, percorso.polyline, origine, codiceDestinazione, true);
    const accessiAlternativi = await cercaAccessi(alternative.filter(f => !fermateNote.has(f.fermata_id)));
    const piuVicine = [...accessi, ...accessiAlternativi]
        .filter(({ info }) => info.durataMs <= MAX_ACCESSO_ALTERNATIVO_MS)
        .sort(perVicinanza);
    for (const accesso of piuVicine) {
        const opzione = await valuta(accesso);
        if (opzione) return { ...opzione, fuori_copertura: true };
    }
    return null;
}
