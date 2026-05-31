import ngeohash from 'ngeohash';
import { redisClient } from '../../../redis.js';

export async function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
    const startTime = Date.now();
    const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [c.id, c]) : []);
    
    const hStart = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, 7);
    const hEnd = ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, 7);

    let candidateIds = [];
    if (redisClient) {
        candidateIds = await redisClient.geoSearch('corse_geo_index', { 
            longitude: richiesta.coord.lon, latitude: richiesta.coord.lat 
        }, { radius: 100, unit: 'km' });
    }

    if (candidateIds.length === 0) return { slots: [], corse: [] };

    // 1. Pipeline per recuperare ZSCORE e PRENOTAZIONI in un colpo solo
    const pipeline = redisClient.multi();
    candidateIds.forEach(id => {
        pipeline.zScore(`corsa:percorso_hash:${id}`, hStart);
        pipeline.zScore(`corsa:percorso_hash:${id}`, hEnd);
        pipeline.hVals(`corsa:prenotazioni:${id}`);
    });

    const results = await pipeline.exec();
    
    const corse = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    // 2. Analisi dei risultati (results è un array flat con i ritorni della pipeline)
    for (let i = 0; i < candidateIds.length; i++) {
        const id = candidateIds[i];
        const c = corseMap.get(Number(id));
        if (!c) continue;

        // Estrazione risultati dalla pipeline (3 operazioni per ogni corsa)
        const idxStart = results[i * 3];
        const idxEnd = results[i * 3 + 1];
        const prenotazioniRaw = results[i * 3 + 2];

        // Validazione logica
        if (idxStart === null || idxEnd === null || idxStart >= idxEnd) continue;

        const occupazioneSegmento = prenotazioniRaw.reduce((max, p) => {
            const item = typeof p === 'string' ? JSON.parse(p) : p;
            const sovrappone = (idxStart < item.end_index_polyline) && (idxEnd > item.start_index_polyline);
            return sovrappone ? max + Number(item.posti_richiesti) : max;
        }, 0);

        const postiLiberi = Number(c.posti_totali) - occupazioneSegmento;

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi - postiRichiesti;
            corse.push(c);
        }
    }

    console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Candidati: ${candidateIds.length} | Risultati: ${corse.length}`);
    return { slots: [], corse };
}