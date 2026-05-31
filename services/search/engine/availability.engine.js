import ngeohash from 'ngeohash';
import { redisClient } from '../../../redis.js';

const GEOHASH_PRECISION = 5;
const BATCH_SIZE = 10; // Processiamo a blocchi per evitare timeout e sovraccarico

export async function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
    const startTime = Date.now();
    const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [Number(c.id), c]) : []);
    
    const hStart = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
    const hEnd = ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, GEOHASH_PRECISION);

    let candidateIds = await redisClient.geoSearch('corse_geo_index', { 
        longitude: richiesta.coord.lon, latitude: richiesta.coord.lat 
    }, { radius: 100, unit: 'km' });

    if (candidateIds.length === 0) return { slots: [], corse: [] };

    const corse = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    // Processamento a blocchi (Batching) per massimizzare la velocità
    for (let i = 0; i < candidateIds.length; i += BATCH_SIZE) {
        const batchIds = candidateIds.slice(i, i + BATCH_SIZE);
        const pipeline = redisClient.multi();

        batchIds.forEach(id => {
            pipeline.zRangeByLex(`corsa:percorso_hash:${id}`, `[${hStart}`, `[${hStart}\xff`, 'LIMIT', 0, 1);
            pipeline.zRangeByLex(`corsa:percorso_hash:${id}`, `[${hEnd}`, `[${hEnd}\xff`, 'LIMIT', 0, 1);
            pipeline.hVals(`corsa:prenotazioni:${id}`);
        });

        const results = await pipeline.exec();
        
        for (let j = 0; j < batchIds.length; j++) {
            const id = batchIds[j];
            const c = corseMap.get(Number(id));
            if (!c) continue;

            // Estrarre risultati dalla pipeline (i risultati sono a gruppi di 3 per ogni ID del batch)
            const resStart = results[j * 3][1];
            const resEnd = results[j * 3 + 1][1];
            const prenotazioniData = results[j * 3 + 2][1];

            if (!resStart?.length || !resEnd?.length) continue;

            // Recuperiamo gli score (usiamo await singolo qui perché è molto veloce)
            const idxStart = await redisClient.zScore(`corsa:percorso_hash:${id}`, resStart[0]);
            const idxEnd = await redisClient.zScore(`corsa:percorso_hash:${id}`, resEnd[0]);

            if (idxStart === null || idxEnd === null || Number(idxStart) >= Number(idxEnd)) continue;

            // Calcolo occupazione
            const occupazione = (prenotazioniData || []).reduce((max, p) => {
                const item = JSON.parse(p);
                return (Number(idxStart) < Number(item.end_index_polyline) && Number(idxEnd) > Number(item.start_index_polyline)) 
                    ? max + Number(item.posti_richiesti || 0) : max;
            }, 0);

            if ((Number(c.posti_totali || 0) - occupazione) >= postiRichiesti) {
                c.postiDisponibili = Number(c.posti_totali) - occupazione;
                corse.push(c);
            }
        }
    }

    console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Risultati: ${corse.length}`);
    return { slots: [], corse };
}