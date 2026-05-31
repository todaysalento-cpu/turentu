import ngeohash from 'ngeohash';
import { redisClient } from '../../../redis.js';

const GEOHASH_PRECISION = 5;

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
        pipeline.zScore(`corsa:percorso_hash:${id}`, hStart);
        pipeline.zScore(`corsa:percorso_hash:${id}`, hEnd);
        pipeline.hVals(`corsa:prenotazioni:${id}`);
    });

    const rawResults = await pipeline.exec();
    
    // Sicurezza: se rawResults è null o non è un array, usciamo per evitare il crash
    if (!rawResults || !Array.isArray(rawResults)) {
        console.error("[SEARCH ENGINE] Errore critico esecuzione pipeline Redis");
        return { slots: [], corse: [] };
    }
    
    const corse = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    for (let i = 0; i < candidateIds.length; i++) {
        const id = candidateIds[i];
        const c = corseMap.get(Number(id));
        if (!c) continue;

        // ACCESSO SICURO: Verifica che ogni step della pipeline sia un array [err, val]
        const opStart = rawResults[i * 3];
        const opEnd = rawResults[i * 3 + 1];
        const opPrenotazioni = rawResults[i * 3 + 2];

        // Se un'operazione è nulla o ha un errore (op[0]), saltiamo questa corsa
        if (!opStart || !opEnd || !opPrenotazioni || opStart[0] || opEnd[0]) {
            continue;
        }

        const idxStart = opStart[1];
        const idxEnd = opEnd[1];
        const prenotazioniRaw = opPrenotazioni[1] || [];

        if (idxStart === null || idxEnd === null || Number(idxStart) >= Number(idxEnd)) continue;

        const occupazioneSegmento = prenotazioniRaw.reduce((max, p) => {
            const item = typeof p === 'string' ? JSON.parse(p) : p;
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