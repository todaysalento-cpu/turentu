import ngeohash from 'ngeohash';
import { redisClient } from '../../../redis.js';

const GEOHASH_PRECISION = 5;

/**
 * Motore di ricerca ottimizzato:
 * Utilizza l'indice inverso Redis 'corsa_in_area' per trovare istantaneamente
 * le corse che transitano nelle aree di partenza e destinazione.
 */
export async function filterDisponibilita(richiesta, veicoliCache, disponibilitaCache, corseCache) {
    const startTime = Date.now();
    const corseMap = corseCache instanceof Map ? corseCache : new Map(Array.isArray(corseCache) ? corseCache.map(c => [Number(c.id), c]) : []);
    
    // 1. Calcoliamo i geohash dell'area di interesse
    const hStart = ngeohash.encode(richiesta.coord.lat, richiesta.coord.lon, GEOHASH_PRECISION);
    const hEnd = ngeohash.encode(richiesta.coordDest.lat, richiesta.coordDest.lon, GEOHASH_PRECISION);

    // 2. Recuperiamo gli ID delle corse che passano sia vicino all'origine che alla destinazione
    const keyStart = `corsa_in_area:${hStart}`;
    const keyEnd = `corsa_in_area:${hEnd}`;
    const candidateIds = await redisClient.sInter(keyStart, keyEnd);

    if (!candidateIds || candidateIds.length === 0) {
        console.log(`ℹ️ [SEARCH] Nessuna corsa trovata che collega ${hStart} a ${hEnd}`);
        return { slots: [], corse: [] };
    }

    const corseValide = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    // 3. Verifica finale: Direzione corretta e Posti disponibili
    for (const id of candidateIds) {
        const c = corseMap.get(Number(id));
        if (!c || !c.decodedCoords) continue;

        // Verifica direzione: l'indice di hStart deve essere inferiore a quello di hEnd
        const idxStart = c.decodedCoords.findIndex(coord => ngeohash.encode(coord[1], coord[0], GEOHASH_PRECISION) === hStart);
        const idxEnd = c.decodedCoords.findIndex(coord => ngeohash.encode(coord[1], coord[0], GEOHASH_PRECISION) === hEnd);

        if (idxStart === -1 || idxEnd === -1 || idxStart >= idxEnd) {
            continue; // Direzione errata o punti non trovati
        }

        // Recuperiamo i dati delle prenotazioni
        const prenotazioniData = await redisClient.hVals(`corsa:prenotazioni:${id}`);
        const occupazione = (prenotazioniData || []).reduce((acc, p) => acc + JSON.parse(p).posti_richiesti, 0);
        const postiLiberi = Number(c.posti_totali || 0) - occupazione;

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        }
    }

    // 4. Mappatura in 'slots' per il formatter
    const slots = corseValide.map(c => ({
        id: `slot_${c.id}`,
        corsa_id: c.id,
        veicolo_id: c.veicolo_id,
        start_datetime: c.start_datetime,
        posti_disponibili: c.postiDisponibili,
        prezzo: c.prezzo_fisso,
        origine_address: c.origine_address,
        destinazione_address: c.destinazione_address
    }));

    console.log(`✅ [SEARCH] Completata in ${Date.now() - startTime}ms | Risultati: ${corseValide.length}`);
    return { slots, corse: corseValide };
}