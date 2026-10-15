
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

const GEOHASH_PRECISION_TRATTA = 5;
const MAX_DISTANZA_NODO_POPBUS_METRI = 3000;
const CLASSI_ANTEPRIMA_POPBUS = ['EXPRESS', 'STANDARD', 'SAVER'];
const MAX_DISTANZA_NODO_TERRITORIALE_METRI = 3000;

// PIXEL: nodi territoriali separati dai nodi_direttrice del matching.
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
    if (Number(origine.id) === Number(destinazione.id)) {
        return { ...base, pixel_stato: 'nodi_coincidenti' };
    }

    // Due fermate sono selezionabili solo se condividono un tipo veicolo.
    const { rows } = await pool.query(`
        SELECT EXISTS (
            SELECT 1
            FROM public.pixel_fermate o
            JOIN public.pixel_fermate d
              ON d.nodo_territoriale_id = $2::BIGINT
            WHERE o.nodo_territoriale_id = $1::BIGINT
              AND o.attiva = TRUE AND o.verificata = TRUE
              AND d.attiva = TRUE AND d.verificata = TRUE
              AND o.tipi_veicolo_ammessi && d.tipi_veicolo_ammessi
        ) AS disponibili
    `, [origine.id, destinazione.id]);

    const disponibili = rows[0]?.disponibili === true;
    return {
        ...base,
        pixel_fermate_disponibili: disponibili,
        pixel_stato: disponibili ? 'disponibile' : 'fermate_non_disponibili'
    };
}


function determinaClasse(indice) {
    if (indice <= 0.3) return 'SAVER';
    if (indice <= 1.5) return 'STANDARD';
    return 'EXPRESS';
}

async function getNearestNode(lat, lon) {
    const { rows } = await pool.query(`
        SELECT id,
               ST_Distance(
                   posizione,
                   ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
               ) AS distanza_metri
        FROM nodi_direttrice
        WHERE posizione IS NOT NULL
        ORDER BY posizione <->
                 ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        LIMIT 1
    `, [lon, lat]);

    const nodo = rows[0];

    return nodo &&
        Number(nodo.distanza_metri) <= MAX_DISTANZA_NODO_POPBUS_METRI
        ? nodo
        : null;
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
        getNearestNode(lat, lon),
        getNearestNode(destLat, destLon)
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
                `🎟️ [SearchEngine] Evento [ID: ${richiesta.evento_id}] -> Dest: ${destLat},${destLon} | Inizio: ${ev.data_inizio}`
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
        `🔍 [SearchEngine] Analisi tratta ${lat},${lon} -> ${destLat},${destLon} (Immediata: ${isImmediata})`
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

    const corsaResults = await Promise.all(
        hashes.map(h =>
            redisClient.sMembers(`corsa:in_area:${h}`)
        )
    );

    const corseCandidate = [
        ...new Set(corsaResults.flat())
    ].map(id => {
        const c = CacheStore.corseCache.get(Number(id));

        if (!c) return null;

        c.classe = determinaClasse(
            Number(c.indice_efficienza || 0)
        );

        return c;
    }).filter(Boolean);

    const corsaIds = corseCandidate
        .map(c => Number(c.id))
        .filter(Boolean);

    let prenotazioniBatch = [];
    const capacitaMap = new Map();

    if (corsaIds.length > 0) {
        const { rows: allPrenotazioni } =
            await pool.query(`
                SELECT
                    corsa_id,
                    posti_richiesti,
                    start_offset,
                    end_offset,
                    start_index_polyline,
                    end_index_polyline
                FROM prenotazioni
                WHERE corsa_id = ANY($1::int[])
            `, [corsaIds]);

        prenotazioniBatch = corseCandidate.map(c =>
            allPrenotazioni.filter(
                p => Number(p.corsa_id) === Number(c.id)
            )
        );

        for (const c of corseCandidate) {
            const cap = c.veicolo_id
                ? await getCapacitaDirettrice(
                    c.veicolo_id,
                    true
                )
                : Number(c.posti_totali || 0);

            capacitaMap.set(c.id, cap);
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

    const { corse: corseValide } =
        await filterDisponibilita(
            requestWithMetrics,
            corseCandidate,
            prenotazioniBatch,
            capacitaMap
        );

    console.log(
        `🔎 [DEBUG CONDIVISE] Corse valide dopo filterDisponibilita: ${corseValide.length}`
    );

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
            `📍 [SEARCH ENGINE MAPPING] Corsa condivisa ID [${c.id}] formattata con offset:`,
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
                        `🚗 [SEARCH ENGINE MAPPING] Corsa privata ID [${slotPrivato.id}] generata con offset:`,
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

    // Una direttrice logica non è una corsa prenotabile.
    // Le corse riempimento confermate arrivano da corseCandidate.
    // Le nuove richieste sono virtuali e pianificate dal worker V2.

    const risultatiPool = [];

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

        // La ricerca PIXEL è informativa: un errore non blocca le corse private.
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
        `📦 [SEARCH ENGINE] Totale risultati finali generati: ${risultatiFinali.length}`
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
