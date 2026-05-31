import ngeohash from 'ngeohash';
import { redisClient } from '../../../redis.js';

// Precisione 5 (~4.9km) per una ricerca geografica tollerante
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

    if (candidateIds.length === 0) {
        console.log("ℹ️ [SEARCH ENGINE] Nessun candidato trovato nel raggio di 100km.");
        return { slots: [], corse: [] };
    }

    const pipeline = redisClient.multi();
    candidateIds.forEach(id => {
        pipeline.zScore(`corsa:percorso_hash:${id}`, hStart);
        pipeline.zScore(`corsa:percorso_hash:${id}`, hEnd);
        pipeline.hVals(`corsa:prenotazioni:${id}`);
    });

    const rawResults = await pipeline.exec();
    
    if (!rawResults || !Array.isArray(rawResults)) {
        console.error("[SEARCH ENGINE] Errore critico: Pipeline Redis non valida");
        return { slots: [], corse: [] };
    }
    
    const corse = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    console.log(`🔍 [SEARCH ENGINE] Processo ${candidateIds.length} candidati geografici...`);

    for (let i = 0; i < candidateIds.length; i++) {
        const id = candidateIds[i];
        const c = corseMap.get(Number(id));
        if (!c) {
            console.log(`⚠️ [DEBUG] Corsa ${id}: Non trovata nella corseMap.`);
            continue;
        }

        const opStart = rawResults[i * 3];
        const opEnd = rawResults[i * 3 + 1];
        const opPrenotazioni = rawResults[i * 3 + 2];

        if (!opStart || !opEnd || !opPrenotazioni || opStart[0] || opEnd[0]) {
            console.log(`❌ [DEBUG] Corsa ${id}: Errore pipeline Redis.`);
            continue;
        }

        const idxStart = opStart[1];
        const idxEnd = opEnd[1];
        
        // --- DIAGNOSTICA GEOSPAZIALE ---
        if (idxStart === null || idxEnd === null) {
            console.log(`🔍 [DEBUG] Corsa ${id}: Geohash NON matchato | hStart: ${hStart}, hEnd: ${hEnd}`);
            continue;
        }

        if (Number(idxStart) >= Number(idxEnd)) {
            console.log(`🔍 [DEBUG] Corsa ${id}: Direzione errata | Start: ${idxStart}, End: ${idxEnd}`);
            continue;
        }

        const prenotazioniData = opPrenotazioni[1];
        const prenotazioniArray = Array.isArray(prenotazioniData) ? prenotazioniData : [];

        const occupazioneSegmento = prenotazioniArray.reduce((max, p) => {
            try {
                const item = typeof p === 'string' ? JSON.parse(p) : p;
                if (!item || typeof item !== 'object') return max;

                const sovrappone = (Number(idxStart) < Number(item.end_index_polyline)) && 
                                   (Number(idxEnd) > Number(item.start_index_polyline));
                
                return sovrappone ? max + Number(item.posti_richiesti || 0) : max;
            } catch (e) {
                return max;
            }
        }, 0);

        const postiLiberi = Number(c.posti_totali || 0) - occupazioneSegmento;

        // --- DIAGNOSTICA DISPONIBILITÀ ---
        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corse.push(c);
            console.log(`✅ [DEBUG] Corsa ${id}: Valida! Posti liberi: ${postiLiberi}`);
        } else {
            console.log(`🔍 [DEBUG] Corsa ${id}: Posti insufficienti (Richiesti: ${postiRichiesti}, Liberi: ${postiLiberi})`);
        }
    }

    console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Candidati: ${candidateIds.length} | Risultati: ${corse.length}`);
    return { slots: [], corse };
}