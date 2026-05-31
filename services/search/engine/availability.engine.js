import * as turf from '@turf/turf';

/**
 * MOTORE DI FILTRAGGIO (Puro calcolo)
 * Aggiunta logica di debug per tracciare lo scarto dei candidati.
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniData) {
    const startTime = Date.now();
    const corseValide = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);

    console.log(`[DEBUG FILTRO] Inizio analisi su ${corseCandidate.length} candidati.`);

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        if (!c?.decodedCoords) {
            console.log(`[DEBUG FILTRO] Corsa ${c.id} scartata: NESSUNA COORDINATA.`);
            continue;
        }

        const route = turf.lineString(c.decodedCoords);
        
        // 1. Verifica geometrica (Turf) - Soglia aumentata a 50km
        const distStart = turf.pointToLineDistance(pStart, route);
        const distEnd = turf.pointToLineDistance(pEnd, route);
        
        console.log(`[DEBUG FILTRO] Corsa ${c.id} distanze: Start=${distStart.toFixed(2)}km, End=${distEnd.toFixed(2)}km`);

        if (distStart > 50 || distEnd > 50) {
            console.log(`[DEBUG FILTRO] Corsa ${c.id} scartata: Distanza punti > 50km.`);
            continue;
        }

        // 2. Verifica Direzione
        const startPointOnLine = turf.nearestPointOnLine(route, pStart);
        const endPointOnLine = turf.nearestPointOnLine(route, pEnd);
        
        if (startPointOnLine.properties.index >= endPointOnLine.properties.index) {
            console.log(`[DEBUG FILTRO] Corsa ${c.id} scartata: Direzione errata (Start index: ${startPointOnLine.properties.index}, End index: ${endPointOnLine.properties.index}).`);
            continue;
        }

        // 3. Calcolo disponibilità
        const occupazione = (prenotazioniData[i] || []).reduce((acc, p) => acc + JSON.parse(p).posti_richiesti, 0);
        const postiLiberi = Number(c.posti_totali || 0) - occupazione;

        if (postiLiberi >= postiRichiesti) {
            console.log(`[DEBUG FILTRO] Corsa ${c.id} ACCETTATA! Posti liberi: ${postiLiberi}`);
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        } else {
            console.log(`[DEBUG FILTRO] Corsa ${c.id} scartata: Posti esauriti (${postiLiberi} disponibili).`);
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