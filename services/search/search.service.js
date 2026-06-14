import * as turf from '@turf/turf';
import ngeohash from 'ngeohash';
import { redisClient } from '../../redis.js';
import { pool } from '../../db/db.js';
import { loadCachesUltra, CacheStore } from './search.cache.js'; 
import { filterDisponibilita } from './engine/availability.engine.js';
import { formatResults } from './formatter/search.formatter.js';
import { getDurataDistanza } from '../../utils/maps.util.js';

const GEOHASH_PRECISION_TRATTA = 5;

function getSnapResult(point, nodi, tolleranzaKm) {
    return nodi.reduce((prev, curr) => {
        const dist = turf.distance(point, turf.point(curr.coord), { units: 'kilometers' });
        return dist < tolleranzaKm && (prev === null || dist < prev.dist) 
            ? { ...curr, dist } : prev;
    }, null);
}

/**
 * Calcola l'occupazione basandosi sui segmenti della direttrice
 */
async function getOccupazioneDinamica(direttriceId, startOffsetMetri, endOffsetMetri) {
    const { rows } = await pool.query(`
        SELECT SUM(s.posti_occupati) as carico
        FROM segmenti s
        JOIN nodi_direttrice n_start ON s.start_node_id = n_start.id
        JOIN nodi_direttrice n_end ON s.end_node_id = n_end.id
        WHERE s.direttrice_id = $1
        AND n_start.offset_metri < $3 
        AND n_end.offset_metri > $2
    `, [direttriceId, startOffsetMetri, endOffsetMetri]);
    return Number(rows[0]?.carico || 0);
}

export async function cercaSlotUltra(richiesta) {
    await loadCachesUltra();

    const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
    const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
    const destLat = Number(richiesta.coordDest?.lat);
    const destLon = Number(richiesta.coordDest?.lon);
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    const orarioRichiesto = new Date(richiesta.start_datetime || new Date());

    const info = await getDurataDistanza({ lat, lon }, { lat: destLat, lon: destLon });
    const distKm = info.distanzaKm || 1;

    // 1. RICERCA GEOSPAZIALE (Corse esistenti)
    const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
    const hashes = [hash, ...ngeohash.neighbors(hash)];
    const corsaResults = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));

    const corseCandidate = [...new Set(corsaResults.flat())].map(id => CacheStore.corseCache.get(Number(id))).filter(Boolean);
    const { corse: corseEsistenti } = await filterDisponibilita({ ...richiesta, posti_richiesti: postiRichiesti }, corseCandidate, []);
    
    const risultatiCondivise = corseEsistenti.map(c => ({ ...c, tipo: 'condivisa', is_slot: false }));

    // 2. LOGICA POP-BUS
    const { rows: direttriciAttivate } = await pool.query(`
        SELECT DISTINCT d.id, d.stato, d.veicolo_id, t.euro_km, t.prezzo_passeggero, d.partenza_prevista
        FROM direttrici_virtuali d
        JOIN tariffe t ON d.veicolo_id = t.veicolo_id
        JOIN nodi_direttrice n1 ON d.id = n1.direttrice_id
        JOIN nodi_direttrice n2 ON d.id = n2.direttrice_id
        WHERE d.stato IN ('in_formazione', 'in_attesa_autista', 'confermata')
        AND ST_DWithin(n1.posizione, ST_SetSRID(ST_MakePoint($1, $2), 4326), 2000)
        AND ST_DWithin(n2.posizione, ST_SetSRID(ST_MakePoint($3, $4), 4326), 2000)
        AND d.partenza_prevista BETWEEN $5::timestamptz - INTERVAL '1 hour' AND $5::timestamptz + INTERVAL '1 hour'
    `, [lon, lat, destLon, destLat, orarioRichiesto.toISOString()]);

    let risultatiPool = [];
    
    for (const dir of direttriciAttivate) {
        const nodi = CacheStore.nodiCache.get(dir.id) || [];
        const veicolo = CacheStore.veicoliCache.get(Number(dir.veicolo_id));
        const capacita = veicolo?.posti_totali || 8;

        const startNode = getSnapResult({coord: [lon, lat]}, nodi, 2.0);
        const endNode = getSnapResult({coord: [destLon, destLat]}, nodi, 2.0);

        // Verifica che i nodi esistano e che l'offset sia coerente (direzione del viaggio)
        if (startNode && endNode && startNode.offset_metri < endNode.offset_metri) {
            const occupati = await getOccupazioneDinamica(dir.id, startNode.offset_metri, endNode.offset_metri);
            const postiDisponibili = capacita - occupati;
            
            if (postiDisponibili >= postiRichiesti) {
                risultatiPool.push({
                    id: `dir_${dir.id}`,
                    tipo: 'pop-bus', 
                    tipo_corsa: dir.stato, 
                    direttrice_id: dir.id,
                    orario: dir.partenza_prevista,
                    posti_disponibili: postiDisponibili, 
                    is_pool: true
                });
            }
        }
    }

    // 3. FALLBACK
    if (risultatiPool.length === 0) {
        risultatiPool.push({
            id: 'nuova_proposta',
            tipo: 'pop-bus',
            tipo_corsa: 'nuova_proposta',
            messaggio: "Nessun bus vicino, richiedi attivazione."
        });
    }

    const risultatiFinali = [...risultatiCondivise, ...risultatiPool];
    return risultatiFinali.length > 0 ? await formatResults({ ...richiesta, distanzaMetri: distKm * 1000 }, risultatiFinali) : [];
}