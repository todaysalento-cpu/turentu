export async function cercaSlotUltra(richiesta) {
    await loadCachesUltra();

    const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
    const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
    const destLat = Number(richiesta.coordDest?.lat);
    const destLon = Number(richiesta.coordDest?.lon);
    const pStart = turf.point([lon, lat]);
    const pEnd = turf.point([destLon, destLat]);
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    const orarioRichiesto = new Date(richiesta.start_datetime || new Date());

    const info = await getDurataDistanza({ lat, lon }, { lat: destLat, lon: destLon });
    const distKm = info.distanzaKm || 1;
    const distanzaMetri = distKm * 1000;

    // 1. RICERCA CORSE ESISTENTI
    const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
    const hashes = [hash, ...ngeohash.neighbors(hash)];
    const corsaResults = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));

    const corseCandidate = [...new Set(corsaResults.flat())]
        .map(id => CacheStore.corseCache.get(Number(id)))
        .filter(Boolean);

    const { corse: corseEsistenti } = await filterDisponibilita({ ...richiesta, posti_richiesti: postiRichiesti }, corseCandidate, []);
    
    const risultatiCondivise = corseEsistenti.map(c => ({ 
        ...c, 
        tipo: 'condivisa', 
        is_pool: false,
        distanza: c.distanza || distanzaMetri 
    }));

    // 2. LOGICA POP-BUS (Rimossa dipendenza da d.prezzo_base)
    const { rows: direttriciAttivate } = await pool.query(`
        SELECT DISTINCT d.id, d.stato, d.veicolo_id, d.linea_geografica::jsonb as linea_geo, d.partenza_prevista
        FROM direttrici_virtuali d
        WHERE d.stato IN ('in_formazione', 'in_attesa_autista', 'confermata')
        AND d.partenza_prevista BETWEEN $1::timestamptz - INTERVAL '1 hour' AND $1::timestamptz + INTERVAL '1 hour'
    `, [orarioRichiesto.toISOString()]);

    let risultatiPool = [];
    for (const dir of direttriciAttivate) {
        const nodi = CacheStore.nodiCache.get(dir.id) || [];
        const veicolo = CacheStore.veicoliCache.get(Number(dir.veicolo_id));
        const capacita = veicolo?.posti_totali || 8;
        
        const line = turf.lineString(dir.linea_geo.coordinates); 

        let startPoint = getSnapResult(pStart, nodi, 2.0);
        let endPoint = getSnapResult(pEnd, nodi, 2.0);

        if (!startPoint) startPoint = getVirtualSnap(pStart, line);
        if (!endPoint) endPoint = getVirtualSnap(pEnd, line);

        if (startPoint && endPoint && startPoint.dist < 3.0 && endPoint.dist < 3.0 && startPoint.offset_metri < endPoint.offset_metri) {
            const occupati = await getOccupazioneDinamica(dir.id, startPoint.offset_metri, endPoint.offset_metri);
            
            if ((capacita - occupati) >= postiRichiesti) {
                risultatiPool.push({
                    id: `dir_${dir.id}`,
                    tipo: 'pop-bus', 
                    tipo_corsa: dir.stato, 
                    direttrice_id: dir.id,
                    veicolo_id: dir.veicolo_id, // Necessario per pricing.util
                    posti_disponibili: capacita - occupati, 
                    posti_totali: capacita,
                    distanza: distanzaMetri,
                    is_pool: true,
                    startOffset: startPoint.offset_metri,
                    endOffset: endPoint.offset_metri,
                    aggancio: { start: startPoint.type, end: endPoint.type }
                });
            }
        }
    }

    // 3. FUSIONE
    const risultatiFinali = [...risultatiCondivise, ...risultatiPool];

    if (risultatiFinali.length === 0) {
        risultatiFinali.push({
            id: 'nuova_proposta',
            tipo: 'pop-bus',
            tipo_corsa: 'nuova_proposta',
            messaggio: "Nessun bus vicino, richiedi attivazione."
        });
    }

    return await formatResults({ ...richiesta, distanzaMetri }, risultatiFinali);
}