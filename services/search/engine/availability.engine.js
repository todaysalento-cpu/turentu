import ngeohash from 'ngeohash';
import { redisClient } from '../../../redis.js';

// Precisione 5 (~4.9km). 
// Usiamo una precisione fissa che bilancia performance e precisione.
const GEOHASH_PRECISION = 5;

export async function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
    const startTime = Date.now();
    const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [Number(c.id), c]) : []);
    
    // Generiamo gli hash di ricerca
    const hStart = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
    const hEnd = ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, GEOHASH_PRECISION);

    let candidateIds = [];
    if (redisClient) {
        // Cerchiamo candidati nel raggio di 100km
        candidateIds = await redisClient.geoSearch('corse_geo_index', { 
            longitude: richiesta.coord.lon, latitude: richiesta.coord.lat 
        }, { radius: 100, unit: 'km' });
    }

    if (candidateIds.length === 0) return { slots: [], corse: [] };

    const pipeline = redisClient.multi();
    candidateIds.forEach(id => {
        // ZRANGEBYLEX permette di trovare l'hash più vicino (lexicographical range)
        // [hStart, hStart\xff] copre tutti i valori che iniziano con l'hash generato
        pipeline.zRangeByLex(`corsa:percorso_hash:${id}`, `[${hStart}`, `[${hStart}\xff`, 'LIMIT', 0, 1);
        pipeline.zRangeByLex(`corsa:percorso_hash:${id}`, `[${hEnd}`, `[${hEnd}\xff`, 'LIMIT', 0, 1);
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

        const resStart = rawResults[i * 3][1]; // Array con l'hash trovato
        const resEnd = rawResults[i * 3 + 1][1];
        const opPrenotazioni = rawResults[i * 3 + 2];

        if (!resStart?.length || !resEnd?.length) continue;

        // Recuperiamo l'indice reale (score) basandoci sull'hash trovato
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
            console.log(`✅ [DEBUG] Corsa ${id} trovata: ${postiLiberi} posti liberi.`);
        }
    }

    console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Risultati: ${corse.length}`);
    return { slots: [], corse };
}