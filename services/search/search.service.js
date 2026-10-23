
import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { pool } from '../../db/db.js';
import { loadCachesUltra, CacheStore } from './search.cache.js';
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDurataDistanza } from '../../utils/maps.util.js';
import { calcolaPrezzo } from '../../utils/pricing.util.js';
import { anteprimaFormazionePopbus } from '../popbus/v2/formation-preview.js';
import { cercaPopbusAttivate } from './popbus-active-search.service.js';
import { pixelCollaudoEnabled } from '../pixel/pixel-collaudo-mode.js';
import { ensurePixelStopsForNode } from '../pixel/pixel-stop-acquisition.service.js';

const GEOHASH_PRECISION_TRATTA = 5;
const CLASSI_ANTEPRIMA_POPBUS = ['EXPRESS', 'STANDARD', 'SAVER'];
const MAX_DISTANZA_NODO_TERRITORIALE_METRI = 3000;

// PIXEL e POPBUS V2 condividono i nodi territoriali.
async function getNearestTerritorialNode(lat, lon) {
    const { rows } = await pool.query(`
        SELECT id, ST_Distance(
            posizione,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) AS distanza_metri
        FROM public.nodi_territoriali
        WHERE attivo = TRUE AND posizione IS NOT NULL
          AND ST_DWithin(
              posizione,
              ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
              $3
          )
        ORDER BY distanza_metri ASC, id ASC
        LIMIT 1
    `, [lon, lat, MAX_DISTANZA_NODO_TERRITORIALE_METRI]);
    return rows[0] ?? null;
}

// Disponibilita' PIXEL commerciale e discovery informativa per il collaudo.
// I candidati Google restano transitori: non sono fermate persistenti prenotabili.
async function getPixelTerritorialContext(lat, lon, destLat, destLon) {
    const [origine, destinazione] = await Promise.all([
        getNearestTerritorialNode(lat, lon),
        getNearestTerritorialNode(destLat, destLon)
    ]);

    const base = {
        origine_nodo_territoriale_id: origine ? Number(origine.id) : null,
        destinazione_nodo_territoriale_id: destinazione ? Number(destinazione.id) : null,
        pixel_fermate_disponibili: false,
        pixel_stato: 'nodi_non_disponibili'
    };

    if (!origine || !destinazione) return base;
    if (String(origine.id) === String(destinazione.id)) {
        return { ...base, pixel_stato: 'nodi_coincidenti' };
    }

    const collaudo = pixelCollaudoEnabled();
    // In collaudo acquisizione on-demand prima del preventivo, in modo che
    // la riquotazione nel booking veda gli stessi ID persistenti.
    if (collaudo) {
        for (const nodeId of [...new Set([String(origine.id), String(destinazione.id)])]) {
            try {
                const result = await ensurePixelStopsForNode(nodeId);
                console.log('[PIXEL COLLAUDO] Nodo', nodeId, result.stato);
            } catch (error) {
                console.warn('[PIXEL COLLAUDO] Acquisizione fallita:', nodeId, error.message);
            }
        }
    }
    const { rows } = await pool.query(`
        SELECT EXISTS (
            SELECT 1
            FROM public.pixel_fermate o
            JOIN public.pixel_fermate d
              ON d.nodo_territoriale_id = $2::BIGINT
            WHERE o.nodo_territoriale_id = $1::BIGINT
              AND ($3::boolean OR (o.attiva = TRUE AND o.verificata = TRUE
                                  AND d.attiva = TRUE AND d.verificata = TRUE))
              AND (
                  o.tipi_veicolo_ammessi && d.tipi_veicolo_ammessi
                  OR ($3::boolean AND
                      (COALESCE(cardinality(o.tipi_veicolo_ammessi),0)=0
                       OR COALESCE(cardinality(d.tipi_veicolo_ammessi),0)=0))
              )
        ) AS disponibili
    `, [origine.id, destinazione.id, collaudo]);
    return {
        ...base,
        pixel_fermate_disponibili: rows[0]?.disponibili === true,
        pixel_stato: rows[0]?.disponibili === true ? 'disponibile' : 'fermate_non_disponibili'
    };
}


function determinaClasse(indice) {
    if (indice <= 0.3) return 'SAVER';
    if (indice <= 1.5) return 'STANDARD';
    return 'EXPRESS';
}

async function caricaAnteprimaFormazione({
    lat,
    lon,
    destLat,
    destLon,
    start_datetime,
    postiRichiesti,
    slot
}) {
    const [origine, destinazione] = await Promise.all([
        getNearestTerritorialNode(lat, lon),
        getNearestTerritorialNode(destLat, destLon)
    ]);

    if (
        !origine ||
        !destinazione ||
        Number(origine.id) === Number(destinazione.id)
    ) {
        console.log(
            '[POPBUS PREVIEW] Nodi non disponibili o non distinti; anteprima omessa'
        );
        return null;
    }

    const prezzi = {};

    for (const classe of CLASSI_ANTEPRIMA_POPBUS) {
        const prezzo = await calcolaPrezzo(
            slot,
            postiRichiesti,
            'pop-bus',
            slot.km_utente,
            slot.km_totali_percorso,
            0,
            classe,
            slot.km_avvicinamento,
            slot.km_riposizionamento
        );

        if (
            prezzo &&
            Number.isFinite(Number(prezzo.prezzo))
        ) {
            prezzi[classe] = Number(prezzo.prezzo);
        }
    }

    if (!Object.keys(prezzi).length) {
        console.warn(
            '[POPBUS PREVIEW DEBUG] Nessun prezzo valido; anteprima omessa'
        );
        return null;
    }

    console.log('[POPBUS PREVIEW INPUT]', JSON.stringify({
        nodo_origine: Number(origine.id),
        distanza_nodo_origine_metri: Number(origine.distanza_metri),
        nodo_destinazione: Number(destinazione.id),
        distanza_nodo_destinazione_metri: Number(destinazione.distanza_metri),
        start_datetime,
        posti_richiesti: postiRichiesti,
        prezzi_totali_simulati: prezzi,
        km_pricing: {
            tratta: slot.km_utente,
            avvicinamento: slot.km_avvicinamento,
            ritorno: slot.km_riposizionamento
        }
    }, null, 2));

    const anteprimaStart = performance.now();

    const anteprima = await anteprimaFormazionePopbus({
        start_node_id: Number(origine.id),
        end_node_id: Number(destinazione.id),
        start_datetime,
        posti_richiesti: postiRichiesti,
        prezzi
    });

    // Diagnostic-only multimission preview: NEVER exposed as bookable.
    // Disabled by default; errors cannot affect the stable search response.
    if (process.env.POPBUS_PREVIEW_MULTIMISSION_ENABLED === '1') {
        try {
            const { anteprimaMultimissioneSearchDB } = await import(
                '../popbus/v2/formation-multimission-search-db-bridge.js'
            );
            const diagnostic = await anteprimaMultimissioneSearchDB({
                start_node_id: Number(origine.id),
                end_node_id: Number(destinazione.id),
                start_datetime,
                posti_richiesti: postiRichiesti,
                prezzi
            });
            console.log('[POPBUS MULTIMISSION SHADOW]', JSON.stringify({
                shadow: diagnostic.shadow,
                dbWrites: diagnostic.dbWrites,
                simulazione_non_prenotabile: diagnostic.simulazione_non_prenotabile,
                classi: Object.fromEntries(Object.entries(diagnostic.classi || {}).map(
                    ([classe, r]) => [classe, {
                        missioni_valutate: r.missioni_valutate,
                        coppie_valutate: r.coppie_valutate,
                        cicli: r.cicli?.length ?? 0,
                        migliore: r.migliore ?? null
                    }]
                ))
            }));
        } catch (error) {
            console.warn('[POPBUS MULTIMISSION SHADOW] Non disponibile:', error.message);
        }
    }

    console.log(
        '[POPBUS ANTEPRIMA RAW]',
        JSON.stringify(anteprima, null, 2)
    );

    console.log(
        '[POPBUS PREVIEW SUMMARY]',
        JSON.stringify(
            Object.fromEntries(
                Object.entries(anteprima || {}).map(([classe, f]) => [
                    classe,
                    {
                        stato: f?.stato ?? null,
                        richieste_compatibili:
                            f?.richieste_compatibili ?? null,
                        posti_in_formazione:
                            f?.posti_in_formazione ?? null,
                        ricavo_attuale:
                            f?.ricavo_attuale ?? null,
                        ricavo_con_richiesta:
                            f?.ricavo_con_richiesta ?? null,
                        costo_attivazione:
                            f?.costo_attivazione ?? null,
                        ricavo_mancante:
                            f?.ricavo_mancante ?? null,
                        ricavo_mancante_dopo_richiesta:
                            f?.ricavo_mancante_dopo_richiesta ?? null,
                        posti_mancanti_stimati:
                            f?.posti_mancanti_stimati ?? null,
                        posti_mancanti_dopo_richiesta_stimati:
                            f?.posti_mancanti_dopo_richiesta_stimati ?? null,
                        richiesta_simulata_inclusa:
                            f?.richiesta_simulata_inclusa ?? null,
                        veicolo_riferimento_id:
                            f?.veicolo_riferimento_id ?? null,
                        costo_percorso_km:
                            f?.costo_percorso_km ?? null,
                        costo_avvicinamento_km:
                            f?.costo_avvicinamento_km ?? null,
                        costo_ritorno_km:
                            f?.costo_ritorno_km ?? null
                    }
                ])
            ),
            null,
            2
        )
    );

    console.log(
        `[POPBUS PREVIEW TEMPO] ${(performance.now() - anteprimaStart).toFixed(1)} ms`
    );

    return anteprima;
}

async function getCapacitaDirettrice(
    direttriceIdOrVeicoloId,
    isVeicolo = false
) {
    if (isVeicolo) {
        const { rows } = await pool.query(`
            SELECT COALESCE(posti_totali, 0) AS capacita
            FROM veicolo
            WHERE id = $1
        `, [direttriceIdOrVeicoloId]);

        return Number(rows[0]?.capacita || 0);
    }

    const { rows } = await pool.query(`
        SELECT COALESCE(SUM(v.posti_totali), 0) AS capacita
        FROM direttrici_virtuali d
        JOIN veicolo v ON v.id = d.veicolo_id
        WHERE d.id = $1
    `, [direttriceIdOrVeicoloId]);

    return Number(rows[0]?.capacita || 0);
}

async function getOccupazioneSegmenti(
    direttriceId,
    seqStart,
    seqEnd
) {
    const { rows } = await pool.query(`
        SELECT COALESCE(MAX(posti_occupati), 0) AS occupati
        FROM segmenti
        WHERE direttrice_id = $1
          AND ordine_sequenziale BETWEEN $2 AND $3
    `, [direttriceId, seqStart, seqEnd]);

    return Number(rows[0]?.occupati || 0);
}

export async function cercaSlotUltra(richiesta) {
    await loadCachesUltra();

    let lat = Number(richiesta.coord?.lat ?? richiesta.lat);
    let lon = Number(
        richiesta.coord?.lon ??
        richiesta.coord?.lng ??
        richiesta.lon
    );

    let destLat = Number(
        richiesta.coordDest?.lat ??
        richiesta.destLat
    );

    let destLon = Number(
        richiesta.coordDest?.lon ??
        richiesta.coordDest?.lng ??
        richiesta.destLon
    );

    let orarioAndataUtente = new Date(
        richiesta.start_datetime || new Date()
    );

    let orarioRitornoUtente = richiesta.return_datetime
        ? new Date(richiesta.return_datetime)
        : null;

    const adesso = new Date();

    const diffMinuti =
        (orarioAndataUtente.getTime() - adesso.getTime()) /
        (1000 * 60);

    const isImmediata =
        diffMinuti >= -5 &&
        diffMinuti <= 30;

    let orarioEventoAndata = null;
    let orarioEventoRitorno = null;

    if (richiesta.evento_id) {
        const { rows: eventoRows } = await pool.query(`
            SELECT lat, lng, data_inizio, data_fine
            FROM eventi
            WHERE id = $1
        `, [richiesta.evento_id]);

        if (eventoRows.length > 0) {
            const ev = eventoRows[0];

            destLat = destLat || ev.lat;
            destLon = destLon || ev.lng;

            orarioEventoAndata = new Date(ev.data_inizio);

            if (ev.data_fine) {
                const fineEvento = new Date(ev.data_fine);
                fineEvento.setMinutes(
                    fineEvento.getMinutes() + 30
                );
                orarioEventoRitorno = fineEvento;
            }

            console.log(
                `ÐYZY‹÷? [SearchEngine] Evento [ID: ${richiesta.evento_id}] -> Dest: ${destLat},${destLon} | Inizio: ${ev.data_inizio}`
            );
        }
    }

    if (!lat || !lon || !destLat || !destLon) {
        return formatResults(richiesta, []);
    }

    const pStart = turf.point([lon, lat]);

    const postiRichiesti = Number(
        richiesta.posti_richiesti || 1
    );

    console.log(
        `ÐY"? [SearchEngine] Analisi tratta ${lat},${lon} -> ${destLat},${destLon} (Immediata: ${isImmediata})`
    );

    const info = await getDurataDistanza(
        { lat, lon },
        { lat: destLat, lon: destLon }
    );

    const distanzaKm = info.distanzaKm || 1;
    const distanzaMetri = distanzaKm * 1000;

    // -------------------------------------------------
    // 1. CORSE CONDIVISE DA CACHE
    // -------------------------------------------------

    const hash = ngeohash.encode(
        lat,
        lon,
        GEOHASH_PRECISION_TRATTA
    );

    const hashes = [
        hash,
        ...ngeohash.neighbors(hash)
    ];

    // Candidati identificati dalla singola tratta, non dalla missione.
    const trattaResults = await Promise.all(
        hashes.map(h => redisClient.sMembers(`tratta:in_area:${h}`))
    );
    const corseCandidate = [...new Set(trattaResults.flat())].map(rawId => {
        const tratta = CacheStore.tratteCache.get(Number(rawId));
        if (!tratta || (tratta.stato_temporale !== 'flessibile' && !tratta.partenza_prevista)) return null;
        if (tratta.stato_temporale === 'flessibile' && tratta.direzione !== 'ritorno') return null;
        const corsa = CacheStore.corseCache.get(Number(tratta.corsa_id));
        if (!corsa || corsa.tipo_corsa !== 'condivisa' || corsa.stato !== 'prenotabile') return null;
        return {
            ...corsa,
            tratta_id: Number(tratta.id),
            direzione: tratta.direzione,
            stato_temporale: tratta.stato_temporale,
            percorso_polyline: tratta.percorso_polyline,
            decodedCoords: tratta.decodedCoords,
            partenza_prevista: tratta.partenza_prevista,
            arrivo_previsto: tratta.arrivo_previsto,
            durata_secondi: tratta.durata_secondi,
            // Ancora temporale della missione: il ritorno flessibile non ha una partenza fissata.
            arrivo_andata_missione: corsa.arrivo_datetime,
            distanza_andata_missione: Number(corsa.distanza),
            km_totali_percorso: Number(tratta.distanza_km),
            distanza: Number(tratta.distanza_km),
            classe: determinaClasse(Number(corsa.indice_efficienza || 0))
        };
    }).filter(Boolean);

    // Diagnostica temporanea NCC 924 / tratta 13: sola lettura, nessuna modifica al matching.
    console.log('[NCC 924/13 CACHE DIAG]', JSON.stringify({
        hashRicerca: hash,
        hashesControllati: hashes,
        idsTratteRedis: [...new Set(trattaResults.flat())],
        tratta13InRedis: trattaResults.flat().some(id => Number(id) === 13),
        tratta13InCache: CacheStore.tratteCache.has(13),
        corsa924InCache: CacheStore.corseCache.has(924),
        tratta13Cache: (() => {
            const t = CacheStore.tratteCache.get(13);
            return t ? {
                id: t.id, corsa_id: t.corsa_id, direzione: t.direzione,
                stato_temporale: t.stato_temporale,
                haPolyline: Boolean(t.percorso_polyline),
                partenza_prevista: t.partenza_prevista
            } : null;
        })(),
        corsa924Cache: (() => {
            const c = CacheStore.corseCache.get(924);
            return c ? { id: c.id, tipo_corsa: c.tipo_corsa, stato: c.stato,
                arrivo_datetime: c.arrivo_datetime, distanza: c.distanza } : null;
        })(),
        tratta13TraCandidate: corseCandidate.some(c => Number(c.id) === 924 && Number(c.tratta_id) === 13)
    }));

    const corsaIds = [...new Set(corseCandidate.map(c => Number(c.id)))];
    let prenotazioniBatch = [];
    const capacitaMap = new Map();
    const modelloAMap = new Map();

    if (corsaIds.length) {
        const { rows: allPrenotazioni } = await pool.query(`
            SELECT corsa_id, tratta_id, id, km_utente, posti_richiesti,
                   start_offset, end_offset, start_index_polyline, end_index_polyline
            FROM prenotazioni
            WHERE corsa_id = ANY($1::int[])
        `, [corsaIds]);
        // Le prenotazioni senza tratta_id sono legacy: non possiamo attribuirle
        // arbitrariamente a una direzione. Escludiamo la missione per sicurezza.
        const corseAmbigue = new Set(allPrenotazioni
            .filter(p => p.tratta_id == null)
            .map(p => Number(p.corsa_id)));
        for (let i = corseCandidate.length - 1; i >= 0; i--) {
            if (corseAmbigue.has(Number(corseCandidate[i].id))) corseCandidate.splice(i, 1);
        }
        console.log('[NCC 924/13 PRENOTAZIONI DIAG]', JSON.stringify({
            prenotazioni924: allPrenotazioni.filter(p => Number(p.corsa_id) === 924)
                .map(p => ({ id: p.id, tratta_id: p.tratta_id })),
            corsa924EsclusaPerAmbiguita: corseAmbigue.has(924),
            tratta13AncoraCandidata: corseCandidate.some(c => Number(c.id) === 924 && Number(c.tratta_id) === 13)
        }));
        prenotazioniBatch = corseCandidate.map(c => allPrenotazioni.filter(p =>
            Number(p.tratta_id) === Number(c.tratta_id)
        ));
        for (const c of corseCandidate) {
            const cap = c.veicolo_id
                ? await getCapacitaDirettrice(c.veicolo_id, true)
                : Number(c.posti_totali || 0);
            capacitaMap.set(c.tratta_id, cap);
        }
        const { rows: snapshots } = await pool.query(`
            SELECT c.id, c.tipo_corsa, c.prezzo_fisso, c.prenotazione_origine_id,
                   p.km_utente AS km_prima_prenotazione
            FROM corse c LEFT JOIN prenotazioni p ON p.id = c.prenotazione_origine_id
            WHERE c.id = ANY($1::int[])
        `, [corsaIds]);
        for (const snapshot of snapshots) {
            if (snapshot.tipo_corsa !== 'condivisa') continue;
            modelloAMap.set(Number(snapshot.id), {
                costoCommercialeMissione: snapshot.prezzo_fisso == null ? null : Number(snapshot.prezzo_fisso),
                kmPrimaPrenotazione: snapshot.km_prima_prenotazione == null ? null : Number(snapshot.km_prima_prenotazione),
                prenotazioni: allPrenotazioni.filter(p => Number(p.corsa_id) === Number(snapshot.id)).map(p => ({
                    id: Number(p.id), km: p.km_utente == null ? null : Number(p.km_utente), posti: Number(p.posti_richiesti)
                }))
            });
        }
    }

    const requestWithMetrics = {
        ...richiesta,
        coord: { lat, lon },
        coordDest: {
            lat: destLat,
            lon: destLon
        },
        posti_richiesti: postiRichiesti,
        return_datetime:
            orarioRitornoUtente ||
            orarioEventoRitorno,
        start_datetime:
            orarioAndataUtente.toISOString(),
        start_index_polyline: Number(
            richiesta.start_index_polyline ?? 0
        ),
        end_index_polyline: Number(
            richiesta.end_index_polyline ??
            distanzaMetri
        )
    };

    console.log('[NCC 899 PRIMA FILTRO]', JSON.stringify(
        corseCandidate
            .filter(c => Number(c.id) === 899 && Number(c.tratta_id) === 3)
            .map(c => ({
                id: c.id,
                tratta_id: c.tratta_id,
                partenza_prevista: c.partenza_prevista,
                durata_secondi: c.durata_secondi,
                capacita: capacitaMap.get(c.tratta_id)
            }))
    ));

    const { corse: corseValide } =
        await filterDisponibilita(
            requestWithMetrics,
            corseCandidate,
            prenotazioniBatch,
            capacitaMap
        );

    console.log(
        `ÐY"Z [DEBUG CONDIVISE] Corse valide dopo filterDisponibilita: ${corseValide.length}`
    );

    console.log('[NCC 899 DOPO FILTRO]', JSON.stringify(
        corseValide
            .filter(c => Number(c.id) === 899 && Number(c.tratta_id) === 3)
            .map(c => ({
                id: c.id,
                tratta_id: c.tratta_id,
                calculated_start_offset: c.calculated_start_offset,
                calculated_end_offset: c.calculated_end_offset
            }))
    ));

    console.log('[NCC 924/13 FILTRO DIAG]', JSON.stringify({
        candidataPrimaFiltro: corseCandidate.some(c => Number(c.id) === 924 && Number(c.tratta_id) === 13),
        validaDopoFiltro: corseValide.some(c => Number(c.id) === 924 && Number(c.tratta_id) === 13),
        dettagliValidi: corseValide.filter(c => Number(c.id) === 924 && Number(c.tratta_id) === 13)
            .map(c => ({ start_offset: c.calculated_start_offset, end_offset: c.calculated_end_offset,
                partenza_proposta_ritorno: c.partenza_proposta_ritorno }))
    }));

    const distanzaCondivisaValida = Number(distanzaKm);

    const risultatiCondivise = corseValide.map(c => {
        const offsetMetri =
            c.calculated_end_offset !== undefined &&
            c.calculated_start_offset !== undefined
                ? (
                    c.calculated_end_offset -
                    c.calculated_start_offset
                )
                : null;

        let kmUtenteTratta =
            offsetMetri !== null
                ? offsetMetri / 1000
                : Number(
                    c.km_utente ||
                    c.distanza ||
                    distanzaCondivisaValida
                );

        if (kmUtenteTratta > 5000) {
            kmUtenteTratta /= 1000;
        }

        const kmTotaliPercorso = Number(
            c.km_totali_percorso ||
            c.km_totali_rotta ||
            c.distanza_totale_corsa ||
            c.distanzaTotaleRotte ||
            kmUtenteTratta
        );

        const startOffsetVal =
            c.calculated_start_offset ?? 0;

        const endOffsetVal =
            c.calculated_end_offset ??
            kmUtenteTratta * 1000;

        const startIndexPoly =
            c.calculated_start_index_polyline ?? 0;

        const endIndexPoly =
            c.calculated_end_index_polyline ?? 100;

        const slotRisultato = {
            ...c,
            tipo: 'condivisa',
            modelloA: modelloAMap.get(Number(c.id)) ?? null,
            is_pool: false,
            distanza: kmUtenteTratta * 1000,
            distanzaKm: kmUtenteTratta,
            km_utente: kmUtenteTratta,
            km_totali_percorso: kmTotaliPercorso,
            start_offset: startOffsetVal,
            end_offset: endOffsetVal,
            startOffset: startOffsetVal,
            endOffset: endOffsetVal,
            start_index_polyline: startIndexPoly,
            end_index_polyline: endIndexPoly,
            partenza_prevista:
                c.partenza_effettiva ||
                c.partenza_prevista ||
                c.partenza
        };

        console.log(
            `ÐY"? [SEARCH ENGINE MAPPING] Corsa condivisa ID [${c.id}] formattata con offset:`,
            {
                start_offset: slotRisultato.start_offset,
                end_offset: slotRisultato.end_offset,
                start_index_polyline:
                    slotRisultato.start_index_polyline,
                end_index_polyline:
                    slotRisultato.end_index_polyline
            }
        );

        return slotRisultato;
    });

    // -------------------------------------------------
    // 2. CORSE PRIVATE
    // -------------------------------------------------

    const veicoliEntries = Array.from(
        CacheStore.veicoloToDisponibilita.entries()
    );

    const risultatiPrivati = (
        await Promise.all(
            veicoliEntries.map(
                async ([veicoloId, disp]) => {
                    const latVeicolo =
                        isImmediata &&
                        disp.lat_live !== null &&
                        disp.lat_live !== undefined
                            ? disp.lat_live
                            : disp.lat_base;

                    const lonVeicolo =
                        isImmediata &&
                        disp.lon_live !== null &&
                        disp.lon_live !== undefined
                            ? disp.lon_live
                            : disp.lon_base;

                    if (
                        latVeicolo === null ||
                        latVeicolo === undefined ||
                        lonVeicolo === null ||
                        lonVeicolo === undefined
                    ) {
                        return null;
                    }

                    const pVeicoloPoint = turf.point([
                        Number(lonVeicolo),
                        Number(latVeicolo)
                    ]);

                    const distVeicoloGeo = turf.distance(
                        pStart,
                        pVeicoloPoint,
                        { units: 'kilometers' }
                    );

                    if (
                        distVeicoloGeo >= 50 ||
                        !disp.is_slot ||
                        disp.disponibile === false
                    ) {
                        return null;
                    }

                    const cap =
                        await getCapacitaDirettrice(
                            disp.veicolo_id,
                            true
                        );

                    if (cap < postiRichiesti) {
                        return null;
                    }

                    let kmAvv = distVeicoloGeo;

                    try {
                        const infoAvv =
                            await getDurataDistanza(
                                {
                                    lat: Number(latVeicolo),
                                    lon: Number(lonVeicolo)
                                },
                                { lat, lon }
                            );

                        if (
                            infoAvv &&
                            infoAvv.distanzaKm
                        ) {
                            kmAvv = infoAvv.distanzaKm;
                        }
                    } catch (err) {}

                    let kmRip = 0;

                    const latBase = disp.lat_base;
                    const lonBase = disp.lon_base;

                    if (
                        latBase !== null &&
                        latBase !== undefined &&
                        lonBase !== null &&
                        lonBase !== undefined
                    ) {
                        try {
                            const infoRip =
                                await getDurataDistanza(
                                    {
                                        lat: destLat,
                                        lon: destLon
                                    },
                                    {
                                        lat: Number(latBase),
                                        lon: Number(lonBase)
                                    }
                                );

                            if (
                                infoRip &&
                                infoRip.distanzaKm
                            ) {
                                kmRip = infoRip.distanzaKm;
                            }
                        } catch (err) {}
                    }

                    const slotPrivato = {
                        id: `priv_${veicoloId}`,
                        tipo: 'privata',
                        veicolo_id: veicoloId,
                        marca:
                            disp.marca ||
                            disp.veicolo?.marca ||
                            '',
                        modello:
                            disp.modello ||
                            disp.veicolo?.modello ||
                            '',
                        classe:
                            disp.classe ||
                            'STANDARD',
                        servizi:
                            disp.servizi || {},
                        posti_disponibili: cap,
                        posti_totali: cap,
                        distanza: distanzaMetri,
                        distanzaKm,
                        km_avvicinamento: kmAvv,
                        km_riposizionamento: kmRip,
                        is_pool: false,
                        is_privato: true,
                        start_offset: 0,
                        end_offset: distanzaMetri,
                        startOffset: 0,
                        endOffset: distanzaMetri,
                        start_index_polyline: 0,
                        end_index_polyline: 100
                    };

                    console.log(
                        `ÐYs- [SEARCH ENGINE MAPPING] Corsa privata ID [${slotPrivato.id}] generata con offset:`,
                        {
                            start_offset:
                                slotPrivato.start_offset,
                            end_offset:
                                slotPrivato.end_offset
                        }
                    );

                    return slotPrivato;
                }
            )
        )
    ).filter(Boolean);

    // -------------------------------------------------
    // 3. POPBUS V2
    // -------------------------------------------------

    // Una direttrice logica non Çù una corsa prenotabile.
    // Le corse riempimento confermate arrivano da corseCandidate.
    // Le nuove richieste sono virtuali e pianificate dal worker V2.

    const risultatiPool = [];

    // POPBUS confermate: verifica diagnostica in sola lettura.
    // Non esponiamo ancora queste corse finchÇ¸ prezzo e Booking non sono validati.
    // Il flag Çù disabilitato per impostazione predefinita.
    const popbusActiveSearchEnabled =
        process.env.POPBUS_ACTIVE_SEARCH_ENABLED === '1';

    if (popbusActiveSearchEnabled) {
        try {
            const popbusConfermate = await cercaPopbusAttivate({
                pool,
                richiesta: {
                    lat,
                    lon,
                    destLat,
                    destLon,
                    start_datetime: orarioAndataUtente.toISOString(),
                    posti_richiesti: postiRichiesti
                }
            });

            console.log('[POPBUS ACTIVE SEARCH]', {
                confermate_compatibili: popbusConfermate.length,
                corsa_ids: popbusConfermate.map(c => c.corsa_id)
            });
            // Intenzionalmente nessun push in risultatiPool.
        } catch (err) {
            console.error('[POPBUS ACTIVE SEARCH] Errore:', err.message);
        }
    }


    let risultatiFinali = [
        ...risultatiCondivise,
        ...risultatiPrivati,
        ...risultatiPool
    ];

    if (risultatiPool.length === 0) {
        const veicoliDisponibiliEntries = Array.from(
            CacheStore.veicoloToDisponibilita.entries()
        ).filter(
            ([_, disp]) => disp.disponibile === true
        );

        const veicoliDisponibiliIds =
            veicoliDisponibiliEntries.map(
                ([id, _]) => id
            );

        let kmAvvFallback = 0;
        let kmRipFallback = 0;

        if (veicoliDisponibiliEntries.length > 0) {
            let minDistance = Infinity;
            let migliorVeicolo = null;

            for (const [vId, disp] of veicoliDisponibiliEntries) {
                const latV =
                    isImmediata &&
                    disp.lat_live != null
                        ? disp.lat_live
                        : disp.lat_base;

                const lonV =
                    isImmediata &&
                    disp.lon_live != null
                        ? disp.lon_live
                        : disp.lon_base;

                if (
                    latV != null &&
                    lonV != null
                ) {
                    const distGeo = turf.distance(
                        pStart,
                        turf.point([
                            Number(lonV),
                            Number(latV)
                        ]),
                        { units: 'kilometers' }
                    );

                    if (distGeo < minDistance) {
                        minDistance = distGeo;
                        migliorVeicolo = disp;
                    }
                }
            }

            if (migliorVeicolo) {
                kmAvvFallback = minDistance;

                try {
                    const latV =
                        isImmediata &&
                        migliorVeicolo.lat_live != null
                            ? migliorVeicolo.lat_live
                            : migliorVeicolo.lat_base;

                    const lonV =
                        isImmediata &&
                        migliorVeicolo.lon_live != null
                            ? migliorVeicolo.lon_live
                            : migliorVeicolo.lon_base;

                    const infoAvv =
                        await getDurataDistanza(
                            {
                                lat: Number(latV),
                                lon: Number(lonV)
                            },
                            { lat, lon }
                        );

                    if (infoAvv?.distanzaKm) {
                        kmAvvFallback =
                            infoAvv.distanzaKm;
                    }
                } catch (e) {}

                if (
                    migliorVeicolo.lat_base != null &&
                    migliorVeicolo.lon_base != null
                ) {
                    try {
                        const infoRip =
                            await getDurataDistanza(
                                {
                                    lat: destLat,
                                    lon: destLon
                                },
                                {
                                    lat: Number(
                                        migliorVeicolo.lat_base
                                    ),
                                    lon: Number(
                                        migliorVeicolo.lon_base
                                    )
                                }
                            );

                        if (infoRip?.distanzaKm) {
                            kmRipFallback =
                                infoRip.distanzaKm;
                        }
                    } catch (e) {}
                }
            }
        }

        // La ricerca PIXEL Çù informativa: un errore non blocca le corse private.
        let pixelContext = {
            origine_nodo_territoriale_id: null,
            destinazione_nodo_territoriale_id: null,
            pixel_fermate_disponibili: false,
            pixel_stato: 'non_verificato'
        };
        try {
            pixelContext = await getPixelTerritorialContext(
                lat, lon, destLat, destLon
            );
        } catch (err) {
            console.error('[PIXEL] Errore associazione nodi territoriali:', err);
        }

        const virtualPopSlot = {
            id: 'virtual_pop_pending',
            ...pixelContext,
            tipo: 'pop-bus',
            is_pool: true,
            veicoli_pool_ids:
                veicoliDisponibiliIds,
            stato: 'in_attesa',
            distanza: distanzaMetri,
            distanzaKm,
            km_utente: distanzaKm,
            km_totali_percorso:
                distanzaKm +
                kmAvvFallback +
                kmRipFallback,
            km_avvicinamento:
                kmAvvFallback,
            km_riposizionamento:
                kmRipFallback,
            start_offset: 0,
            end_offset: distanzaMetri,
            startOffset: 0,
            endOffset: distanzaMetri,
            start_index_polyline: 0,
            end_index_polyline: 100,
            messaggio:
                'Opzioni POPBUS virtuali disponibili, in attesa di attivazione.'
        };

        // Anteprima informativa: un errore non deve interrompere la ricerca.
        try {
            const anteprima =
                await caricaAnteprimaFormazione({
                    lat,
                    lon,
                    destLat,
                    destLon,
                    start_datetime:
                        orarioAndataUtente.toISOString(),
                    postiRichiesti,
                    slot: virtualPopSlot
                });

            if (anteprima) {
                virtualPopSlot.formazioni_popbus =
                    anteprima;

                virtualPopSlot.anteprima_formazione =
                    true;

                console.log(
                    '[POPBUS PREVIEW ATTACHED]',
                    {
                        slot_id: virtualPopSlot.id,
                        classi: Object.keys(anteprima),
                        express_presente:
                            Boolean(anteprima.EXPRESS),
                        express_stato:
                            anteprima.EXPRESS?.stato ?? null,
                        express_posti_esistenti:
                            anteprima.EXPRESS?.posti_in_formazione ?? null,
                        express_posti_mancanti:
                            anteprima.EXPRESS?.posti_mancanti_stimati ?? null,
                        express_posti_mancanti_dopo:
                            anteprima.EXPRESS?.posti_mancanti_dopo_richiesta_stimati ?? null
                    }
                );
            } else {
                console.warn(
                    '[POPBUS PREVIEW ATTACHED] Anteprima nulla: il formatter potrebbe usare un fallback'
                );
            }
        } catch (err) {
            console.warn(
                '[POPBUS PREVIEW] Anteprima non disponibile:',
                err.message
            );
        }

        risultatiFinali.push(
            virtualPopSlot
        );
    }

    console.log(
        `ÐY"Ý [SEARCH ENGINE] Totale risultati finali generati: ${risultatiFinali.length}`
    );

    return await formatResults({
        ...richiesta,
        coord: { lat, lon },
        coordDest: {
            lat: destLat,
            lon: destLon
        },
        distanzaKm,
        distanzaMetri,
        posti_richiesti:
            postiRichiesti,
        return_datetime:
            orarioRitornoUtente ||
            orarioEventoRitorno
    }, risultatiFinali);
}
