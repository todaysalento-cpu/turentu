import { readFile } from 'node:fs/promises';
import { haversineDistance } from '../../utils/geo.util.js';
import { getDurataDistanza } from '../../utils/maps.util.js';
import { classePercorrenza, QUALITA_PERCORRENZA, SOGLIE_PERCORRENZA_KM } from '../popbus/v2/model.js';

const RAGGIO_KM = 8;
const MAX_ACCESSO_MS = 12 * 60000;
const MAX_RACCOLTE = 2;

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

function comuniCompatibili(comuni, provincia, destinazione, classe) {
    return [...comuni.values()].flatMap(comune => {
        if (!comune.codice.startsWith(provincia) || comune.codice === destinazione.codice) return [];
        const distanza = haversineDistance(comune, destinazione);
        // Filtro geografico preliminare. La classe effettiva usa la strada nella Search.
        const { bassaMax, mediaMax } = SOGLIE_PERCORRENZA_KM;
        if (classe === 'MEDIA' && (distanza * 1.3 < bassaMax || distanza > mediaMax)) return [];
        if (classe === 'LUNGA' && distanza * 1.3 <= mediaMax) return [];
        return [{ comune, distanza }];
    });
}

export function pianificaPuntiRaccolta({ comuni, fermate, provincia, destinazione, classe }) {
    const localita = comuniCompatibili(comuni, provincia, destinazione, classe);
    const qualita = QUALITA_PERCORRENZA[classe];
    const candidati = fermate.flatMap(fermata => {
        const kmVersoDestinazione = haversineDistance(fermata, destinazione);
        const copertura = new Map();
        for (const { comune, distanza } of localita) {
            const accesso = haversineDistance(comune, fermata);
            const maxKm = distanza * (1 + qualita.maxDeviazionePct / 100);
            if (accesso <= RAGGIO_KM && accesso + kmVersoDestinazione <= maxKm) {
                copertura.set(comune.codice, accesso);
            }
        }
        if (!copertura.size) return [];
        return [{ fermata, copertura, popolazione: Number(fermata.popolazione) ||
            comuni.get(fermata.codice)?.popolazione || 0 }];
    }).sort((a, b) => Number(a.fermata.fermata_id) - Number(b.fermata.fermata_id));

    let migliore = { punti: [], coperti: 0, popolazione: 0, distanza: Infinity };
    function valuta(punti) {
        const coperti = new Map();
        for (const { copertura } of punti) {
            for (const [codice, km] of copertura) {
                coperti.set(codice, Math.min(km, coperti.get(codice) ?? Infinity));
            }
        }
        const popolazione = punti.reduce((somma, p) => somma + p.popolazione, 0);
        const distanza = [...coperti.values()].reduce((somma, km) => somma + km, 0);
        if (coperti.size > migliore.coperti ||
            (coperti.size === migliore.coperti && punti.length < migliore.punti.length) ||
            (coperti.size === migliore.coperti && punti.length === migliore.punti.length &&
                (popolazione > migliore.popolazione ||
                    (popolazione === migliore.popolazione && distanza < migliore.distanza)))) {
            migliore = { punti, coperti: coperti.size, popolazione, distanza };
        }
    }

    const limite = Math.min(MAX_RACCOLTE, qualita.maxFermate);
    for (const [i, prima] of candidati.entries()) {
        valuta([prima]);
        if (limite < 2) continue;
        for (const seconda of candidati.slice(i + 1)) {
            if (prima.fermata.codice !== seconda.fermata.codice) valuta([prima, seconda]);
        }
    }
    return migliore.punti.map(p => p.fermata);
}

async function fermateDellaDirettrice(pool, provincia, codiceDestinazione) {
    const { rows } = await pool.query(`
        SELECT DISTINCT ON (n.codice_istat_comune)
               n.id AS nodo_id, n.codice_istat_comune AS codice, d.popolazione,
               btrim(split_part(n.nome, ',', 1)) AS localita,
               f.id AS fermata_id, f.nome AS fermata,
               ST_Y(f.posizione::geometry) AS lat, ST_X(f.posizione::geometry) AS lon
        FROM public.nodi_territoriali n
        JOIN public.pixel_fermate f ON f.nodo_territoriale_id = n.id AND f.attiva
        LEFT JOIN public.pixel_demografia d ON d.nodo_territoriale_id = n.id
        WHERE n.attivo AND n.codice_istat_comune LIKE $1 AND n.codice_istat_comune <> $2
          AND upper(ltrim(f.nome)) NOT LIKE 'TEST PIXEL%'
          AND upper(ltrim(f.nome)) NOT LIKE '[TEST PIXEL]%'
          AND NOT EXISTS (
              SELECT 1 FROM public.pixel_fermate_test_metadata t WHERE t.fermata_id = f.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.pixel_fermate_fonti ff
              WHERE ff.fermata_id = f.id AND ff.stato_verifica = 'non_ammessa'
          )
        ORDER BY n.codice_istat_comune,
                 (d.popolazione IS NOT NULL) DESC,
                 ST_Distance(f.posizione::geography, n.posizione::geography), f.id
    `, [`${provincia}%`, codiceDestinazione]);
    return rows;
}

export async function scegliRaccoltaPopbus({
    pool, origine, destinazione, codiceOrigine, codiceDestinazione, distanzaKm,
    route = getDurataDistanza, caricaTerritorio = comuniRaccolta
}) {
    if (!percorrenzaConRaccolta(distanzaKm) ||
        !/^\d{6}$/.test(codiceOrigine) || !/^\d{6}$/.test(codiceDestinazione) ||
        codiceOrigine === codiceDestinazione) return null;

    const classe = classePercorrenza({}, distanzaKm);
    const provincia = codiceOrigine.slice(0, 3);
    const comuni = await caricaTerritorio();
    const centroDestinazione = comuni.get(codiceDestinazione);
    if (!centroDestinazione) return null;

    const fermate = await fermateDellaDirettrice(pool, provincia, codiceDestinazione);
    const piano = pianificaPuntiRaccolta({ comuni, fermate, provincia, destinazione: centroDestinazione, classe });
    const accessi = await Promise.all(piano.flatMap(fermata => {
        const km = haversineDistance(origine, fermata);
        if (km > RAGGIO_KM) return [];
        return [(async () => {
            const info = km <= 0.01 ? { distanzaKm: 0, durataMs: 0 } : await route(origine, fermata);
            if (km > 0.01 && !(info.distanzaKm > 0 && info.durataMs > 0)) return null;
            return info.durataMs <= MAX_ACCESSO_MS ? { fermata, info } : null;
        })()];
    }));
    const ordinati = accessi.filter(Boolean).sort((a, b) => a.info.durataMs - b.info.durataMs ||
        a.info.distanzaKm - b.info.distanzaKm || Number(a.fermata.fermata_id) - Number(b.fermata.fermata_id));

    const maxKm = distanzaKm * (1 + QUALITA_PERCORRENZA[classe].maxDeviazionePct / 100);
    for (const { fermata, info } of ordinati) {
        const tratta = await route(fermata, destinazione);
        if (!(tratta.distanzaKm > 0 && tratta.durataMs > 0) ||
            info.distanzaKm + tratta.distanzaKm > maxKm) continue;

        return {
            nodo_id: Number(fermata.nodo_id),
            fermata_id: Number(fermata.fermata_id),
            localita: fermata.localita,
            nome: fermata.fermata,
            lat: fermata.lat,
            lon: fermata.lon,
            accesso_minuti: Math.ceil(info.durataMs / 60000),
            tratta_km: tratta.distanzaKm,
            tratta_minuti: tratta.durataMs / 60000
        };
    }
    return null;
}
