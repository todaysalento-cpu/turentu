import ngeohash from 'ngeohash';
import { redisClient } from '../../../redis.js';

// Precisione 5 (~4.9km)
const GEOHASH_PRECISION = 5;
// Tolleranza per trovare punti vicini al percorso (es. 1 valore di scostamento nello score)
const TOLERANCE = 2; 

export async function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
    const startTime = Date.now();
    const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [Number(c.id), c]) : []);
    
    const hStart = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
    const hEnd = ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, GEOHASH_PRECISION);

    let candidateIds = [];
    if (redisClient) {
        candidateIds = await redisClient.geoSearch('corse_geo_index', { 
            longitude: richiesta.coord.lon, latitude: richiesta.coord.lat 
        }, { radius: 100, unit: 'km' });
    }

    if (candidateIds.length === 0) return { slots: [], corse: [] };

    const pipeline = redisClient.multi();
    candidateIds.forEach(id => {
        // Usiamo ZRANGE per trovare il punto più vicino al Geohash (tolleranza sui vicini)
        // Questo evita il fallimento se il punto non è identico
        pipeline.zRangeByLex(`corsa:percorso_hash:${id}`, `[${hStart}`, `[${hStart}\xff`);
        pipeline.zRangeByLex(`corsa:percorso_hash:${id}`, `[${hEnd}`, `[${hEnd}\xff`);
        pipeline.hVals(`corsa:prenotazioni:${id}`);
    });

    const rawResults = await pipeline.exec();
    
    if (!rawResults || !Array.isArray(rawResults)) return { slots: [], corse: [] };
    
    const corse = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    for (let i = 0; i < candidateIds.length; i++) {
        const id = candidateIds[i];
        const c = corseMap.get(Number(id));
        if (!c) continue;

        const resStart = rawResults[i * 3][1];
        const resEnd = rawResults[i * 3 + 1][1];
        const opPrenotazioni = rawResults[i * 3 + 2];

        // Se non troviamo match via ZRange, proviamo a recuperare lo score (indice)
        if (!resStart?.length || !resEnd?.length) continue;

        // Recuperiamo l'indice del segmento (score) associato al Geohash trovato
        const idxStart = await redisClient.zScore(`corsa:percorso_hash:${id}`, resStart[0]);
        const idxEnd = await redisClient.zScore(`corsa:percorso_hash:${id}`, resEnd[0]);

        if (idxStart === null || idxEnd === null || Number(idxStart) >= Number(idxEnd)) continue;

        const prenotazioniData = opPrenotazioni[1];
        const prenotazioniArray = Array.isArray(prenotazioniData) ? prenotazioniData : [];

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
    }

    return { slots: [], corse };
}