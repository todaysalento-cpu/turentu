import ngeohash from 'ngeohash';
import { redisClient } from '../../../redis.js';

// Precisione 5 (~4.9km)
const GEOHASH_PRECISION = 5;

export async function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
    const startTime = Date.now();
    const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [Number(c.id), c]) : []);
    
    // Hash di ricerca
    const hStart = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
    const hEnd = ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, GEOHASH_PRECISION);

    let candidateIds = [];
    if (redisClient) {
        candidateIds = await redisClient.geoSearch('corse_geo_index', { 
            longitude: richiesta.coord.lon, latitude: richiesta.coord.lat 
        }, { radius: 100, unit: 'km' });
    }

    if (candidateIds.length === 0) {
        console.log("ℹ️ [SEARCH ENGINE] Nessun candidato trovato nel raggio di 100km.");
        return { slots: [], corse: [] };
    }

    const corse = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    console.log(`🔍 [SEARCH ENGINE] Processo ${candidateIds.length} candidati via query atomica...`);

    // Utilizziamo un ciclo asincrono per evitare fallimenti di pipeline bloccanti
    for (const id of candidateIds) {
        try {
            const c = corseMap.get(Number(id));
            if (!c) continue;

            // 1. Cerchiamo l'hash più vicino nella ZSET del percorso
            const startMatches = await redisClient.zRangeByLex(`corsa:percorso_hash:${id}`, `[${hStart}`, `[${hStart}\xff`, 'LIMIT', 0, 1);
            const endMatches = await redisClient.zRangeByLex(`corsa:percorso_hash:${id}`, `[${hEnd}`, `[${hEnd}\xff`, 'LIMIT', 0, 1);

            if (!startMatches?.length || !endMatches?.length) continue;

            // 2. Recuperiamo gli indici (score) basandoci sull'hash trovato
            const idxStart = await redisClient.zScore(`corsa:percorso_hash:${id}`, startMatches[0]);
            const idxEnd = await redisClient.zScore(`corsa:percorso_hash:${id}`, endMatches[0]);

            if (idxStart === null || idxEnd === null || Number(idxStart) >= Number(idxEnd)) continue;

            // 3. Recuperiamo le prenotazioni per questo specifico ID
            const prenotazioniData = await redisClient.hVals(`corsa:prenotazioni:${id}`);
            const prenotazioniArray = Array.isArray(prenotazioniData) ? prenotazioniData : [];

            // 4. Calcolo occupazione segmentata
            const occupazioneSegmento = prenotazioniArray.reduce((max, p) => {
                try {
                    const item = typeof p === 'string' ? JSON.parse(p) : p;
                    if (!item || typeof item !== 'object') return max;

                    const sovrappone = (Number(idxStart) < Number(item.end_index_polyline)) && 
                                       (Number(idxEnd) > Number(item.start_index_polyline));
                    
                    return sovrappone ? max + Number(item.posti_richiesti || 0) : max;
                } catch (e) { return max; }
            }, 0);

            const postiLiberi = Number(c.posti_totali || 0) - occupazioneSegmento;

            if (postiLiberi >= postiRichiesti) {
                c.postiDisponibili = postiLiberi;
                corse.push(c);
            }
        } catch (err) {
            console.error(`⚠️ [SEARCH ENGINE] Errore processando corsa ${id}:`, err);
        }
    }

    console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Risultati: ${corse.length}`);
    return { slots: [], corse };
}