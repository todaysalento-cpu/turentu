import * as turf from '@turf/turf';

/**
 * Motore di calcolo occupazione: determina i posti liberi su un segmento specifico
 */
function calcolaPostiDisponibiliSuTratta(corsa, startIdx, endIdx, prenotazioni) {
    const puntiCritici = new Set([startIdx, endIdx]);
    
    prenotazioni.forEach(p => {
        // Fallback: se gli indici mancano, usiamo valori estremi o ignoriamo
        const sIdx = p.start_index_polyline ?? 0;
        const eIdx = p.end_index_polyline ?? corsa.decodedCoords.length;
        if (sIdx > startIdx && sIdx < endIdx) puntiCritici.add(sIdx);
        if (eIdx > startIdx && eIdx < endIdx) puntiCritici.add(eIdx);
    });

    let maxOccupazione = 0;
    for (let punto of puntiCritici) {
        const occupazioneAlPunto = prenotazioni.reduce((acc, p) => {
            const sIdx = p.start_index_polyline ?? 0;
            const eIdx = p.end_index_polyline ?? corsa.decodedCoords.length;
            if (punto >= sIdx && punto < eIdx) {
                return acc + (Number(p.posti_richiesti) || 0);
            }
            return acc;
        }, 0);
        if (occupazioneAlPunto > maxOccupazione) maxOccupazione = occupazioneAlPunto;
    }

    return Number(corsa.posti_totali || 0) - maxOccupazione;
}

/**
 * Filtra le corse basandosi sulla disponibilità spaziale e temporale
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    const corseValide = [];
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    // Tolleranza estesa per corse a lunga percorrenza
    const TOLLERANZA_KM = 150; 

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        if (!c.decodedCoords || c.decodedCoords.length < 2) continue;

        const route = turf.lineString(c.decodedCoords);
        
        // 1. Filtro Spaziale con Logging
        const distStart = turf.pointToLineDistance(pStart, route);
        const distEnd = turf.pointToLineDistance(pEnd, route);
        
        if (distStart > TOLLERANZA_KM || distEnd > TOLLERANZA_KM) {
            // Log silente: puoi decommentarlo per debug estremo
            // console.log(`[FILTER] Corsa ${c.id} fuori tolleranza: ${distStart.toFixed(1)}km/${distEnd.toFixed(1)}km`);
            continue;
        }

        // 2. Filtro Direzione migliorato
        const startIdx = turf.nearestPointOnLine(route, pStart).properties.index;
        const endIdx = turf.nearestPointOnLine(route, pEnd).properties.index;
        
        // Se endIdx <= startIdx, la corsa è in direzione opposta o troppo breve
        if (endIdx <= startIdx) continue; 

        // 3. Calcolo Disponibilità
        const prenotazioni = prenotazioniBatch[i] || [];
        const postiDisponibili = calcolaPostiDisponibiliSuTratta(c, startIdx, endIdx, prenotazioni);

        if (postiDisponibili >= richiesta.posti_richiesti) {
            corseValide.push({ ...c, postiDisponibili, startIdx, endIdx });
        }
    }
    
    console.log(`[ENGINE] Ricerca completata: trovate ${corseValide.length} corse valide.`);
    return { corse: corseValide };
}

export function filterSlotOnly(richiesta, allSlots) {
    return allSlots.filter(s => s.disponibile && (s.posti_totali >= richiesta.posti_richiesti));
}