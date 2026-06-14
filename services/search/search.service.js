import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { pool } from '../../db/db.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDurataDistanza } from '../../utils/maps.util.js';

const GEOHASH_PRECISION_TRATTA = 5;

// Helper: Snap to node (Logica Statica)
function getSnapResult(point, nodi, tolleranzaKm) {
    return nodi.reduce((prev, curr) => {
        const dist = turf.distance(point, turf.point(curr.coord), { units: 'kilometers' });
        return dist < tolleranzaKm && (prev === null || dist < prev.dist) 
            ? { ...curr, dist, type: 'STATIC' } : prev;
    }, null);
}

// Helper: Snap to line (Logica Dinamica/Virtuale)
function getVirtualSnap(point, lineaGeografica) {
    const snapped = turf.nearestPointOnLine(lineaGeografica, point, { units: 'kilometers' });
    return {
        coord: snapped.geometry.coordinates,
        offset_metri: snapped.properties.location * 1000,
        dist: snapped.properties.dist,
        type: 'DYNAMIC'
    };
}

/**
 * Calcola l'occupazione totale sommando segmenti (confermati) 
 * e richieste Pop-Bus (convertite/in attesa)
 */
async function getOccupazioneDinamica(direttriceId, startOffset, endOffset) {
    const { rows } = await pool.query(`
        SELECT COALESCE(SUM(posti), 0) as totale_carico FROM (
            -- 1. Posti già consolidati in segmenti
            SELECT SUM(s.posti_occupati) as posti 
            FROM segmenti s
            JOIN nodi_direttrice n_start ON s.start_node_id = n_start.id
            JOIN nodi_direttrice n_end ON s.end_node_id = n_end.id
            WHERE s.direttrice_id = $1 
            AND n_start.offset_metri < $3 
            AND n_end.offset_metri > $2
            
            UNION ALL
            
            -- 2. Posti riservati in richieste Pop-Bus (convertite o già accettate)
            SELECT SUM(r.posti_richiesti) as posti 
            FROM richieste_pop_bus r
            JOIN direttrici_richieste dr ON r.id = dr.richiesta_id
            WHERE dr.direttrice_id = $1 
            AND r.stato IN ('convertita', 'accettata')
        ) as sub
    `, [direttriceId, startOffset, endOffset]);
    
    return Number(rows[0]?.totale_carico || 0);
}

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

    // 1. RICERCA CORSE ESISTENTI (Redis)
    const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
    const hashes = [hash, ...ngeohash.neighbors(hash)];
    const corsaResults = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));

    const corseCandidate = [...new Set(corsaResults.flat())]
        .map(id => CacheStore.corseCache.get(Number(id)))
        .filter(Boolean);

    const { corse: corseEsistenti } = await filterDisponibilita({ ...richiesta, posti_richiesti: postiRichiesti }, corseCandidate, []);
    
    const risultatiCondivise = corseEsistenti.map(c => ({ 
        ...c, 
        tipo: c.tipo || 'condivisa', 
        is_pool: false,
        distanza: c.distanza || distanzaMetri,
        prezzo_fisso: Number(c.prezzo_fisso) || 0
    }));

    // 2. SINTESI CORSE PRIVATE
    const risultatiPrivati = [];
    for (const [veicoloId, disp] of CacheStore.veicoloToDisponibilita) {
        const distVeicolo = turf.distance(pStart, turf.point([Number(disp.lon), Number(disp.lat)]), { units: 'kilometers' });
        if (disp.is_slot && disp.disponibile !== false && distVeicolo < 50) {
            risultatiPrivati.push({
                id: `priv_${veicoloId}`,
                tipo: 'privata',
                veicolo_id: veicoloId,
                posti_disponibili: 8,
                posti_totali: 8,
                distanza: distanzaMetri,
                is_pool: false,
                messaggio: "Disponibile per corsa privata"
            });
        }
    }

    // 3. LOGICA POP-BUS
    const { rows: direttriciAttivate } = await pool.query(`
        SELECT DISTINCT d.id, d.stato, d.veicolo_id, d.linea_geografica::jsonb as linea_geo, d.partenza_prevista
        FROM direttrici_virtuali d
        WHERE d.stato IN ('in_formazione', 'in_attesa_autista', 'confermata')
        AND d.partenza_prevista BETWEEN $1::timestamptz - INTERVAL '1 hour' AND $1::timestamptz + INTERVAL '1 hour'
    `, [orarioRichiesto.toISOString()]);

    const risultatiPool = (await Promise.all(direttriciAttivate.map(async (dir) => {
        const nodi = CacheStore.nodiCache.get(dir.id) || [];
        const veicolo = CacheStore.veicoliCache.get(Number(dir.veicolo_id));
        const capacita = veicolo?.posti_totali || 8;
        const line = turf.lineString(dir.linea_geo.coordinates); 

        let startPoint = getSnapResult(pStart, nodi, 2.0) || getVirtualSnap(pStart, line);
        let endPoint = getSnapResult(pEnd, nodi, 2.0) || getVirtualSnap(pEnd, line);

        if (startPoint && endPoint && startPoint.dist < 3.0 && endPoint.dist < 3.0 && startPoint.offset_metri < endPoint.offset_metri) {
            const occupati = await getOccupazioneDinamica(dir.id, startPoint.offset_metri, endPoint.offset_metri);
            if ((capacita - occupati) >= postiRichiesti) {
                return {
                    id: `dir_${dir.id}`,
                    tipo: 'pop-bus', 
                    tipo_corsa: dir.stato, 
                    direttrice_id: dir.id,
                    veicolo_id: dir.veicolo_id || null, 
                    posti_disponibili: capacita - occupati, 
                    posti_totali: capacita,
                    distanza: distanzaMetri,
                    is_pool: true,
                    startOffset: startPoint.offset_metri,
                    endOffset: endPoint.offset_metri,
                    aggancio: { start: startPoint.type, end: endPoint.type }
                };
            }
        }
        return null;
    }))).filter(Boolean);

    // 4. FUSIONE E RISPOSTA
    const risultatiFinali = [...risultatiCondivise, ...risultatiPrivati, ...risultatiPool];

    risultatiFinali.push({
        id: 'nuova_proposta',
        tipo: 'pop-bus',
        tipo_corsa: 'nuova_proposta',
        is_pool: true, 
        messaggio: "Non trovi il bus perfetto? Richiedi l'attivazione di una nuova direttrice.",
        is_nuova_proposta: true,
        distanza: distanzaMetri,
        posti_totali: 8,
        posti_disponibili: 8
    });

    return await formatResults({ ...richiesta, distanzaMetri }, risultatiFinali);
}