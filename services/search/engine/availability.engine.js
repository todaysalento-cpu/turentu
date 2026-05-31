import ngeohash from 'ngeohash';
import { redisClient } from '../../../redis.js';

// Precisione 5 (~4.9km) per essere tolleranti sul matching iniziale dei punti
const GEOHASH_PRECISION = 5;

export async function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
    const startTime = Date.now();
    const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [Number(c.id), c]) : []);
    
    // Usiamo precisione 5 per il matching dei punti sulla polyline
    const hStart = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
    const hEnd = ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, GEOHASH_PRECISION);

    let candidateIds = [];
    if (redisClient) {
        // Filtro largo geospaziale
        candidateIds = await redisClient.geoSearch('corse_geo_index', { 
            longitude: richiesta.coord.lon, latitude: richiesta.coord.lat 
        }, { radius: 100, unit: 'km' });
    }

    if (candidateIds.length === 0) return { slots: [], corse: [] };

    const pipeline = redisClient.multi();
    candidateIds.forEach(id => {
        pipeline.zScore(`corsa:percorso_hash:${id}`, hStart);
        pipeline.zScore(`corsa:percorso_hash:${id}`, hEnd);
        pipeline.hVals(`corsa:prenotazioni:${id}`);
    });

    // Esecuzione pipeline: returns [[err, res1], [err, res2], ...]
    const rawResults = await pipeline.exec();
    
    const corse = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    for (let i = 0; i < candidateIds.length; i++) {
        const id = candidateIds[i];
        const c = corseMap.get(Number(id));
        if (!c) continue;

        // Estrazione sicura: rawResults[index][1] contiene il valore effettivo
        const idxStart = rawResults[i * 3][1];
        const idxEnd = rawResults[i * 3 + 1][1];
        const prenotazioniRaw = rawResults[i * 3 + 2][1] || [];

        // Validazione logica
        if (idxStart === null || idxEnd === null || Number(idxStart) >= Number(idxEnd)) continue;

        // Calcolo occupazione
        const occupazioneSegmento = prenotazioniRaw.reduce((max, p) => {
            const item = typeof p === 'string' ? JSON.parse(p) : p;
            // Verifica sovrapposizione indici
            const sovrappone = (Number(idxStart) < Number(item.end_index_polyline)) && 
                               (Number(idxEnd) > Number(item.start_index_polyline));
            return sovrappone ? max + Number(item.posti_richiesti || 0) : max;
        }, 0);

        const postiLiberi = Number(c.posti_totali || 0) - occupazioneSegmento;

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corse.push(c);
        }
    }

    console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Candidati: ${candidateIds.length} | Risultati: ${corse.length}`);
    return { slots: [], corse };
}