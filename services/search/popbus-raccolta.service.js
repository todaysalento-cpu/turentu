import { readFile } from 'node:fs/promises';
import { getDurataDistanza } from '../../utils/maps.util.js';
import { classePercorrenza, QUALITA_PERCORRENZA } from '../popbus/v2/model.js';

const RAGGIO_RICERCA_METRI = 8000;
const MAX_ACCESSO_MS = 10 * 60000;
const MAX_NODI = 6;

let comuniPromise;
const normalizza = nome => String(nome ?? '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function comuniDalDataset() {
    comuniPromise ??= readFile(new URL('../../data/ISTAT/ASL_comuni_popolazione_2024.csv', import.meta.url), 'utf8')
        .then(csv => {
            const [header, ...righe] = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
            const colonne = header.split(';');
            const codice = colonne.indexOf('CODICE COMUNE');
            const nome = colonne.indexOf('COMUNE');
            const totale = colonne.indexOf('TOTALE');
            return new Map(righe.flatMap(riga => {
                const valori = riga.split(';').map(v => v.trim());
                const residenti = Number(valori[totale]?.replaceAll('.', ''));
                if (!/^\d{6}$/.test(valori[codice]) || !valori[nome] || !(residenti > 0)) return [];
                return [[valori[codice], { nome: normalizza(valori[nome]), residenti }]];
            }));
        });
    return comuniPromise;
}

function popolazioneLocale(valore, codice, nome, comuni) {
    if (valore != null && Number.isFinite(Number(valore))) return Number(valore);
    const comune = comuni.get(String(codice ?? '').trim().padStart(6, '0'));
    if (!comune) return null;
    if (comune.nome === normalizza(nome)) return comune.residenti;
    // Per una frazione senza dato proprio, valuta come raccolta i comuni vicini.
    return null;
}

export async function scegliRaccoltaPopbus({
    pool, origine, destinazione, origineNodoId, destinazioneNodoId,
    distanzaKm, route = getDurataDistanza
}) {
    const classe = classePercorrenza({}, distanzaKm);
    if (!classe || classe === 'BASSA' || !origineNodoId || !destinazioneNodoId ||
        origineNodoId === destinazioneNodoId) return null;

    // Una fermata di riferimento per nodo rende la proposta stabile fra ricerche diverse.
    const { rows } = await pool.query(`
        WITH punto AS (
            SELECT ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography AS posizione
        )
        SELECT DISTINCT ON (n.id)
               n.id AS nodo_id, btrim(split_part(n.nome, ',', 1)) AS localita,
               n.codice_istat_comune AS codice, d.popolazione,
               btrim(split_part(o.nome, ',', 1)) AS localita_origine,
               o.codice_istat_comune AS codice_origine, od.popolazione AS popolazione_origine,
               f.id AS fermata_id, f.nome AS fermata,
               ST_Y(f.posizione::geometry) AS lat, ST_X(f.posizione::geometry) AS lon,
               ST_Distance(f.posizione::geography, p.posizione) AS distanza
        FROM public.nodi_territoriali o
        JOIN public.nodi_territoriali n ON n.attivo AND n.id NOT IN ($1, $2)
        LEFT JOIN public.pixel_demografia d ON d.nodo_territoriale_id = n.id
        LEFT JOIN public.pixel_demografia od ON od.nodo_territoriale_id = o.id
        JOIN public.pixel_fermate f ON f.nodo_territoriale_id = n.id AND f.attiva
        CROSS JOIN punto p
        WHERE o.id = $1 AND o.attivo
          AND ST_DWithin(n.posizione::geography, p.posizione, $5)
          AND upper(ltrim(f.nome)) NOT LIKE 'TEST PIXEL%'
          AND upper(ltrim(f.nome)) NOT LIKE '[TEST PIXEL]%'
          AND NOT EXISTS (
              SELECT 1 FROM public.pixel_fermate_test_metadata t WHERE t.fermata_id = f.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.pixel_fermate_fonti ff
              WHERE ff.fermata_id = f.id AND ff.stato_verifica = 'non_ammessa'
          )
        ORDER BY n.id, ST_Distance(f.posizione::geography, n.posizione::geography), f.id
    `, [origineNodoId, destinazioneNodoId, origine.lon, origine.lat, RAGGIO_RICERCA_METRI]);

    if (!rows.length) return null;
    const comuni = await comuniDalDataset().catch(() => new Map());
    const da = rows[0];
    const popolazioneOrigine = popolazioneLocale(
        da.popolazione_origine, da.codice_origine, da.localita_origine, comuni
    );
    const comuneOrigine = comuni.get(String(da.codice_origine ?? '').trim().padStart(6, '0'));
    const frazioneSenzaDato = popolazioneOrigine == null && comuneOrigine &&
        normalizza(da.localita_origine) !== comuneOrigine.nome;

    const candidati = rows.filter(f => {
        if (f.distanza > RAGGIO_RICERCA_METRI) return false;
        const popolazione = popolazioneLocale(f.popolazione, f.codice, f.localita, comuni);
        return popolazione != null && (frazioneSenzaDato ||
            (popolazioneOrigine != null && popolazione > popolazioneOrigine));
    })
        .sort((a, b) => a.distanza - b.distanza || Number(a.nodo_id) - Number(b.nodo_id))
        .slice(0, MAX_NODI);

    const accessi = await Promise.all(candidati.map(async fermata => {
        const info = await route(origine, fermata);
        return { fermata, info };
    }));
    accessi.sort((a, b) => a.info.durataMs - b.info.durataMs ||
        a.info.distanzaKm - b.info.distanzaKm || Number(a.fermata.nodo_id) - Number(b.fermata.nodo_id));

    const maxKm = distanzaKm * (1 + QUALITA_PERCORRENZA[classe].maxDeviazionePct / 100);
    for (const { fermata, info } of accessi) {
        if (!(info.durataMs > 0 && info.durataMs <= MAX_ACCESSO_MS && info.distanzaKm > 0)) continue;

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
