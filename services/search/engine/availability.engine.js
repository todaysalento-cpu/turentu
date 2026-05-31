import ngeohash from 'ngeohash';
import { redisClient } from '../../../redis.js';

const GEOHASH_PRECISION = 5;

/**
 * Motore di ricerca ottimizzato:
 * Utilizza l'indice inverso Redis 'corsa_in_area' per trovare istantaneamente
 * le corse che transitano nella zona di partenza e destinazione.
 */
export async function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
    const startTime = Date.now();
    const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [Number(c.id), c]) : []);
    
    // 1. Calcoliamo i geohash dell'area di interesse (Start e End)
    const hStart = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
    const hEnd = ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, GEOHASH_PRECISION);

    // 2. Recuperiamo gli ID delle corse che passano nelle aree (usando l'indice inverso tollerante)
    // SINTER su Redis trova l'intersezione tra le corse che passano per la partenza e quelle per l'arrivo
    const keyStart = `corsa_in_area:${hStart}`;
    const keyEnd = `corsa_in_area:${hEnd}`;
    
    // Cerchiamo corse che passano sia vicino all'origine che vicino alla destinazione
    const candidateIds = await redisClient.sInter(keyStart, keyEnd);

    if (!candidateIds || candidateIds.length === 0) {
        console.log(`ℹ️ [SEARCH] Nessuna corsa trovata che collega ${hStart} a ${hEnd}`);
        return { slots: [], corse: [] };
    }

    const corseValide = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    // 3. Verifica finale dei vincoli di business (posti e direzione)
    for (const id of candidateIds) {
        const c = corseMap.get(Number(id));
        if (!c) continue;

        // Recuperiamo i dati delle prenotazioni per calcolare i posti liberi reali
        const prenotazioniData = await redisClient.hVals(`corsa:prenotazioni:${id}`);
        
        // Calcolo occupazione (logica semplificata basata sui posti totali vs prenotati)
        const occupazione = (prenotazioniData || []).reduce((acc, p) => acc + JSON.parse(p).posti_richiesti, 0);
        const postiLiberi = Number(c.posti_totali || 0) - occupazione;

        // Filtro finale: posti disponibili
        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        } else {
            console.log(`🔍 [DEBUG] Corsa ${id}: Posti insufficienti (${postiLiberi} < ${postiRichiesti})`);
        }
    }

    console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Risultati: ${corseValide.length}`);
    return { slots: [], corse: corseValide };
}