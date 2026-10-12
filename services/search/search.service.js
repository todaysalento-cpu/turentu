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

        const virtualPopSlot = {
            id: 'virtual_pop_pending',
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

                console.log('[POPBUS PREVIEW ATTACHED]', {
                    slot_id: virtualPopSlot.id,
                    classi: Object.keys(anteprima),
                    express_presente: Boolean(anteprima.EXPRESS),
                    express_stato: anteprima.EXPRESS?.stato ?? null,
                    express_posti_esistenti: anteprima.EXPRESS?.posti_in_formazione ?? null,
                    express_posti_mancanti: anteprima.EXPRESS?.posti_mancanti_stimati ?? null,
                    express_posti_mancanti_dopo: anteprima.EXPRESS?.posti_mancanti_dopo_richiesta_stimati ?? null
                });
            } else {
                console.warn('[POPBUS PREVIEW ATTACHED] Anteprima nulla: il formatter potrebbe usare un fallback');
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