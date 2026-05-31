import * as turf from '@turf/turf';

/**
 * MOTORE DI FILTRAGGIO (Puro calcolo)
 * Non interroga più Redis, riceve i dati già filtrati dall'orchestratore.
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniData) {
    const startTime = Date.now();
    const corseValide = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        if (!c?.decodedCoords) continue;

        const route = turf.lineString(c.decodedCoords);
        
        // 1. Verifica geometrica (Turf)
        if (turf.pointToLineDistance(pStart, route) > 10 || turf.pointToLineDistance(pEnd, route) > 10) continue;

        // 2. Verifica Direzione
        const startPointOnLine = turf.nearestPointOnLine(route, pStart);
        const endPointOnLine = turf.nearestPointOnLine(route, pEnd);
        if (startPointOnLine.properties.index >= endPointOnLine.properties.index) continue;

        // 3. Calcolo disponibilità (prenotazioniData passato dall'esterno)
        const occupazione = (prenotazioniData[i] || []).reduce((acc, p) => acc + JSON.parse(p).posti_richiesti, 0);
        const postiLiberi = Number(c.posti_totali || 0) - occupazione;

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        }
    }

    console.log(`✅ [FILTER] Elaborati ${corseCandidate.length} candidati in ${Date.now() - startTime}ms`);
    return {
        slots: corseValide.map(c => ({
            id: `slot_${c.id}`,
            corsa_id: c.id,
            posti_disponibili: c.postiDisponibili,
            prezzo: c.prezzo_fisso,
            start_datetime: c.start_datetime
        })),
        corse: corseValide
    };
}