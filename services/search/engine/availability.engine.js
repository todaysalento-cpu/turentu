import * as turf from '@turf/turf';
import { redisClient } from '../../../redis.js';

const GEOHASH_PRECISION = 5;

export async function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
    const startTime = Date.now();
    const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [Number(c.id), c]) : []);
    
    // 1. Cerchiamo solo per la zona di origine (molto più permissivo)
    const hStart = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
    const candidateIds = await redisClient.sMembers(`corsa_in_area:${hStart}`);

    if (!candidateIds || candidateIds.length === 0) return { slots: [], corse: [] };

    const corseValide = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);

    for (const id of candidateIds) {
        const c = corseMap.get(Number(id));
        if (!c || !c.decodedCoords) continue;

        // 2. Usiamo Turf per verificare la validità del percorso geometrico
        const route = turf.lineString(c.decodedCoords);
        
        // Verifica se il percorso passa vicino all'origine E alla destinazione
        const distStart = turf.pointToLineDistance(pStart, route, { units: 'kilometers' });
        const distEnd = turf.pointToLineDistance(pEnd, route, { units: 'kilometers' });

        // Tolleranza: 10km dal punto di richiesta
        if (distStart > 10 || distEnd > 10) continue;

        // 3. Verifica Direzione (l'origine deve essere prima della destinazione nel percorso)
        const startPointOnLine = turf.nearestPointOnLine(route, pStart);
        const endPointOnLine = turf.nearestPointOnLine(route, pEnd);
        
        if (startPointOnLine.properties.index >= endPointOnLine.properties.index) continue;

        // 4. Verifica posti
        const prenotazioniData = await redisClient.hVals(`corsa:prenotazioni:${id}`);
        const occupazione = (prenotazioniData || []).reduce((acc, p) => acc + JSON.parse(p).posti_richiesti, 0);
        const postiLiberi = Number(c.posti_totali || 0) - occupazione;

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        }
    }

    // 5. Generazione slot per il formatter
    const slots = corseValide.map(c => ({
        id: `slot_${c.id}`,
        corsa_id: c.id,
        posti_disponibili: c.postiDisponibili,
        prezzo: c.prezzo_fisso,
        start_datetime: c.start_datetime
    }));

    console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Risultati: ${corseValide.length}`);
    return { slots, corse: corseValide };
}