import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { pool } from '../../db/db.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDurataDistanza } from '../../utils/maps.util.js';

const GEOHASH_PRECISION_TRATTA = 5;

function determinaClasse(indice) {
    if (indice <= 0.3) return 'SAVER';
    if (indice <= 1.5) return 'STANDARD';
    return 'EXPRESS';
}

async function getNearestNode(lat, lon) {
    const { rows } = await pool.query(`
        SELECT id FROM nodi_direttrice 
        ORDER BY posizione <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography 
        LIMIT 1
    `, [lon, lat]);
    return rows[0];
}

async function getCapacitaDirettrice(direttriceIdOrVeicoloId, isVeicolo = false) {
    if (isVeicolo) {
        const { rows } = await pool.query(`
            SELECT COALESCE(posti_totali, 0) as capacita
            FROM veicolo
            WHERE id = $1
        `, [direttriceIdOrVeicoloId]);
        return Number(rows[0]?.capacita || 0);
    }

    const { rows } = await pool.query(`
        SELECT COALESCE(SUM(v.posti_totali), 0) as capacita
        FROM direttrici_virtuali d
        JOIN veicolo v ON v.id = d.veicolo_id
        WHERE d.id = $1
    `, [direttriceIdOrVeicoloId]);
    return Number(rows[0]?.capacita || 0);
}

async function getOccupazioneSegmenti(direttriceId, seqStart, seqEnd) {
    const { rows } = await pool.query(`
        SELECT COALESCE(SUM(posti_occupati), 0) as occupati
        FROM segmenti
        WHERE direttrice_id = $1 
        AND ordine_sequenziale BETWEEN $2 AND $3
    `, [direttriceId, seqStart, seqEnd]);
    return Number(rows[0]?.occupati || 0);
}

export async function cercaSlotUltra(richiesta) {
    await loadCachesUltra();

    let lat = Number(richiesta.coord?.lat ?? richiesta.lat);
    let lon = Number(richiesta.coord?.lon ?? richiesta.coord?.lng ?? richiesta.lon);
    let destLat = Number(richiesta.coordDest?.lat ?? richiesta.destLat);
    let destLon = Number(richiesta.coordDest?.lon ?? richiesta.destLon ?? richiesta.destLng);

    // Orari standard richiesti dall'utente
    let orarioAndataUtente = new Date(richiesta.start_datetime || new Date());
    let orarioRitornoUtente = richiesta.return_datetime ? new Date(richiesta.return_datetime) : null;

    // Controllo se la richiesta è immediata (adesso o entro i prossimi 30 minuti)
    const adesso = new Date();
    const diffMinuti = (orarioAndataUtente.getTime() - adesso.getTime()) / (1000 * 60);
    const isImmediata = diffMinuti >= -5 && diffMinuti <= 30;

    let orarioEventoAndata = null;
    let orarioEventoRitorno = null;

    // Se la ricerca è legata a un evento, recuperiamo coordinate e orari dedicati
    if (richiesta.evento_id) {
        const { rows: eventoRows } = await pool.query(`
            SELECT lat, lng, data_inizio, data_fine FROM eventi WHERE id = $1
        `, [richiesta.evento_id]);

        if (eventoRows.length > 0) {
            const ev = eventoRows[0];
            destLat = destLat || ev.lat;
            destLon = destLon || ev.lng;
            orarioEventoAndata = new Date(ev.data_inizio);
            if (ev.data_fine) {
                const fineEvento = new Date(ev.data_fine);
                fineEvento.setMinutes(fineEvento.getMinutes() + 30);
                orarioEventoRitorno = fineEvento;
            }
            console.log(`🎟️ [SearchEngine] Evento [ID: ${richiesta.evento_id}] -> Dest: ${destLat},${destLon} | Inizio: ${ev.data_inizio}`);
        }
    }

    if (!lat || !lon || !destLat || !destLon) return formatResults(richiesta, []);

    const pStart = turf.point([lon, lat]);
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    console.log(`🔍 [SearchEngine] Analisi tratta ${lat},${lon} -> ${destLat},${destLon} (Immediata: ${isImmediata})`);

    const info = await getDurataDistanza({ lat, lon }, { lat: destLat, lon: destLon });
    const distanzaMetri = (info.distanzaKm || 1) * 1000;

    // --- 1. CORSE DA CACHE (Condivise) ---
    const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
    const hashes = [hash, ...ngeohash.neighbors(hash)];
    const corsaResults = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));
    
    const corseCandidate = [...new Set(corsaResults.flat())].map(id => {
        const c = CacheStore.corseCache.get(Number(id));
        if (!c) return null;
        c.classe = determinaClasse(Number(c.indice_efficienza || 0));
        return c;
    }).filter(Boolean);

    console.log(`🔎 [DEBUG CONDIVISE] Trovate ${corsaResults.flat().length} chiavi totali su Redis. Corse uniche candidate estratte dalla cache: ${corseCandidate.length}`);

    // Recupera le prenotazioni dal DB per tutte le corse candidate trovate in cache
    const corsaIds = corseCandidate.map(c => Number(c.id)).filter(Boolean);
    let prenotazioniBatch = [];
    
    if (corsaIds.length > 0) {
        const { rows: allPrenotazioni } = await pool.query(
            `SELECT corsa_id, posti_richiesti, start_index_polyline, end_index_polyline 
             FROM prenotazioni 
             WHERE corsa_id = ANY($1::int[])`,
            [corsaIds]
        );

        // Mappa le prenotazioni raggruppandole nello stesso ordine delle corse candidate
        prenotazioniBatch = corseCandidate.map(c => 
            allPrenotazioni.filter(p => Number(p.corsa_id) === Number(c.id))
        );
    }

    const { corse: corseValide } = await filterDisponibilita({ 
        ...richiesta, 
        posti_richiesti: postiRichiesti,
        return_datetime: orarioRitornoUtente || orarioEventoRitorno 
    }, corseCandidate, prenotazioniBatch);
    
    console.log(`🔎 [DEBUG CONDIVISE] Corse valide dopo filterDisponibilita: ${corseValide.length}`);

    const risultatiCondivise = corseValide.map(c => ({ 
        ...c, 
        tipo: 'condivisa', 
        is_pool: false, 
        distanza: c.distanza || distanzaMetri 
    }));

    // --- 2. CORSE PRIVATE ---
    console.log(`🚗 [DEBUG PRIVATI] Totale veicoli presenti in CacheStore.veicoloToDisponibilita: ${CacheStore.veicoloToDisponibilita.size}`);
    const veicoliEntries = Array.from(CacheStore.veicoloToDisponibilita.entries());

    const risultatiPrivati = (await Promise.all(veicoliEntries.map(async ([veicoloId, disp]) => {
        const latVeicolo = (isImmediata && disp.lat_live !== null && disp.lat_live !== undefined) ? disp.lat_live : disp.lat_base;
        const lonVeicolo = (isImmediata && disp.lon_live !== null && disp.lon_live !== undefined) ? disp.lon_live : disp.lon_base;

        if (latVeicolo === null || latVeicolo === undefined || lonVeicolo === null || lonVeicolo === undefined) {
            return null;
        }

        const pVeicoloPoint = turf.point([Number(lonVeicolo), Number(latVeicolo)]);
        const distVeicoloGeo = turf.distance(pStart, pVeicoloPoint, { units: 'kilometers' });
        
        if (distVeicoloGeo >= 50 || !disp.is_slot || disp.disponibile === false) {
            return null;
        }

        const cap = await getCapacitaDirettrice(disp.veicolo_id, true);

        let kmAvv = distVeicoloGeo;
        try {
            const infoAvv = await getDurataDistanza({ lat: Number(latVeicolo), lon: Number(lonVeicolo) }, { lat, lon });
            if (infoAvv && infoAvv.distanzaKm) kmAvv = infoAvv.distanzaKm;
        } catch (err) {}

        let kmRip = 0;
        const latBase = disp.lat_base;
        const lonBase = disp.lon_base;
        if (latBase !== null && latBase !== undefined && lonBase !== null && lonBase !== undefined) {
            try {
                const infoRip = await getDurataDistanza({ lat: destLat, lon: destLon }, { lat: Number(latBase), lon: Number(lonBase) });
                if (infoRip && infoRip.distanzaKm) kmRip = infoRip.distanzaKm;
            } catch (err) {}
        }

        return {
            id: `priv_${veicoloId}`, 
            tipo: 'privata', 
            veicolo_id: veicoloId, 
            marca: disp.marca || disp.veicolo?.marca || '',
            modello: disp.modello || disp.veicolo?.modello || '',
            classe: disp.classe || 'STANDARD',
            servizi: disp.servizi || {},
            posti_disponibili: cap,
            posti_totali: cap, 
            distanza: distanzaMetri, 
            km_avvicinamento: kmAvv,
            km_riposizionamento: kmRip,
            is_pool: false,
            is_privato: true
        };
    }))).filter(Boolean);

    // --- 3. POP-BUS ---
    const orariRicercaPool = [orarioAndataUtente];
    if (orarioEventoAndata) orariRicercaPool.push(orarioEventoAndata);

    let direttriciAttivateSet = new Map();

    for (const orarioTarget of orariRicercaPool) {
        const { rows: direttrici } = await pool.query(`
            SELECT d.id, d.stato, d.partenza_prevista, d.veicolo_id, d.tipo_servizio, MIN(s1.ordine_sequenziale) as min_seq, MAX(s2.ordine_sequenziale) as max_seq
            FROM direttrici_virtuali d
            JOIN segmenti s1 ON d.id = s1.direttrice_id
            JOIN segmenti s2 ON d.id = s2.direttrice_id
            WHERE d.stato IN ('in_formazione', 'in_attesa_autista', 'confermata')
            AND d.partenza_prevista BETWEEN $1::timestamptz - INTERVAL '2 hours' AND $1::timestamptz + INTERVAL '2 hours'
            GROUP BY d.id, d.stato, d.partenza_prevista, d.veicolo_id, d.tipo_servizio
        `, [orarioTarget.toISOString()]);

        direttrici.forEach(d => direttriciAttivateSet.set(d.id, d));
    }

    console.log(`🚌 [DEBUG POOL] Direttrici virtuali trovate nel DB nel range orario: ${direttriciAttivateSet.size}`);

    const risultatiPool = (await Promise.all(Array.from(direttriciAttivateSet.values()).map(async (dir) => {
        const occupati = await getOccupazioneSegmenti(dir.id, dir.min_seq, dir.max_seq);
        const capacita = await getCapacitaDirettrice(dir.id);
        const disponibili = capacita - occupati;
        
        if (disponibili >= postiRichiesti) {
            const dispVeicolo = CacheStore.veicoloToDisponibilita.get(dir.veicolo_id) || {};
            
            // Calcolo avvicinamento e riposizionamento per direttrice attiva
            let kmAvvPool = 0;
            let kmRipPool = 0;
            const latV = (isImmediata && dispVeicolo.lat_live != null) ? dispVeicolo.lat_live : dispVeicolo.lat_base;
            const lonV = (isImmediata && dispVeicolo.lon_live != null) ? dispVeicolo.lon_live : dispVeicolo.lon_base;

            if (latV != null && lonV != null) {
                try {
                    const infoAvv = await getDurataDistanza({ lat: Number(latV), lon: Number(lonV) }, { lat, lon });
                    if (infoAvv?.distanzaKm) kmAvvPool = infoAvv.distanzaKm;
                } catch (e) {}

                if (dispVeicolo.lat_base != null && dispVeicolo.lon_base != null) {
                    try {
                        const infoRip = await getDurataDistanza({ lat: destLat, lon: destLon }, { lat: Number(dispVeicolo.lat_base), lon: Number(dispVeicolo.lon_base) });
                        if (infoRip?.distanzaKm) kmRipPool = infoRip.distanzaKm;
                    } catch (e) {}
                }
            }

            return { 
                id: `pop_${dir.id}`, 
                tipo: 'pop-bus', 
                direttrice_id: dir.id, 
                veicolo_id: dir.veicolo_id,
                marca: dispVeicolo.marca || dispVeicolo.veicolo?.marca || '',
                modello: dispVeicolo.modello || dispVeicolo.veicolo?.modello || '',
                partenza_prevista: dir.partenza_prevista,
                posti_disponibili: disponibili, 
                posti_totali: capacita, 
                distanza: distanzaMetri, 
                km_avvicinamento: kmAvvPool,
                km_riposizionamento: kmRipPool,
                is_pool: true,
                include_ritorno: !!orarioRitornoUtente || !!orarioEventoRitorno
            };
        }
        return null;
    }))).filter(Boolean);

    let risultatiFinali = [...risultatiCondivise, ...risultatiPrivati, ...risultatiPool];
    console.log(`📊 [SearchEngine] Risultati finali prima del fallback: Condivise=${risultatiCondivise.length}, Private=${risultatiPrivati.length}, Pool=${risultatiPool.length}`);

    if (risultatiPool.length === 0) {
        console.log(`ℹ️ [DEBUG FALLBACK] Nessun pool attivo trovato. Inserimento card virtuale di fallback (virtual_pop_pending).`);
        
        const veicoliDisponibiliEntries = Array.from(CacheStore.veicoloToDisponibilita.entries())
            .filter(([_, disp]) => disp.disponibile === true);
        
        const veicoliDisponibiliIds = veicoliDisponibiliEntries.map(([id, _]) => id);

        let kmAvvFallback = 0;
        let kmRipFallback = 0;

        if (veicoliDisponibiliEntries.length > 0) {
            let minDistance = Infinity;
            let migliorVeicolo = null;

            for (const [vId, disp] of veicoliDisponibiliEntries) {
                const latV = (isImmediata && disp.lat_live != null) ? disp.lat_live : disp.lat_base;
                const lonV = (isImmediata && disp.lon_live != null) ? disp.lon_live : disp.lon_base;
                
                if (latV != null && lonV != null) {
                    const distGeo = turf.distance(pStart, turf.point([Number(lonV), Number(latV)]), { units: 'kilometers' });
                    if (distGeo < minDistance) {
                        minDistance = distGeo;
                        migliorVeicolo = disp;
                    }
                }
            }

            if (migliorVeicolo) {
                kmAvvFallback = minDistance;
                try {
                    const latV = (isImmediata && migliorVeicolo.lat_live != null) ? migliorVeicolo.lat_live : migliorVeicolo.lat_base;
                    const lonV = (isImmediata && migliorVeicolo.lon_live != null) ? migliorVeicolo.lon_live : migliorVeicolo.lon_base;
                    const infoAvv = await getDurataDistanza({ lat: Number(latV), lon: Number(lonV) }, { lat, lon });
                    if (infoAvv?.distanzaKm) kmAvvFallback = infoAvv.distanzaKm;
                } catch (e) {}

                if (migliorVeicolo.lat_base != null && migliorVeicolo.lon_base != null) {
                    try {
                        const infoRip = await getDurataDistanza({ lat: destLat, lon: destLon }, { lat: Number(migliorVeicolo.lat_base), lon: Number(migliorVeicolo.lon_base) });
                        if (infoRip?.distanzaKm) kmRipFallback = infoRip.distanzaKm;
                    } catch (e) {}
                }
            }
        }
        
        risultatiFinali.push({
            id: `virtual_pop_pending`,
            tipo: 'pop-bus',
            is_pool: true,
            veicoli_pool_ids: veicoliDisponibiliIds,
            stato: 'in_attesa',
            distanza: distanzaMetri,
            distanzaTotaleRotte: distanzaMetri,
            km_avvicinamento: kmAvvFallback,
            km_riposizionamento: kmRipFallback,
            messaggio: `Nessun pool attivo trovato, opzioni virtuali pronte per la selezione.`
        });
    }

    return await formatResults({ 
        ...richiesta, 
        distanzaMetri, 
        return_datetime: orarioRitornoUtente || orarioEventoRitorno 
    }, risultatiFinali);
}