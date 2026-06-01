import * as turf from '@turf/turf';

/**
 * Motore di calcolo occupazione: determina i posti liberi su un segmento specifico
 */
function calcolaPostiDisponibiliSuTratta(corsa, startIdx, endIdx, prenotazioni) {
    const puntiCritici = new Set([startIdx, endIdx]);
    
    // Identifica tutti i punti di salita/discesa esistenti all'interno della tratta
    prenotazioni.forEach(p => {
        const sIdx = p.start_index_polyline;
        const eIdx = p.end_index_polyline;
        if (sIdx > startIdx && sIdx < endIdx) puntiCritici.add(sIdx);
        if (eIdx > startIdx && eIdx < endIdx) puntiCritici.add(eIdx);
    });

    // Trova il picco di occupazione (Worst-Case)
    let maxOccupazione = 0;
    for (let punto of puntiCritici) {
        const occupazioneAlPunto = prenotazioni.reduce((acc, p) => {
            // Verifica sovrapposizione tra la richiesta attuale e la prenotazione esistente
            if (punto >= p.start_index_polyline && punto < p.end_index_polyline) {
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
    const TOLLERANZA_KM = 50; 

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        const route = turf.lineString(c.decodedCoords);
        
        // 1. Filtro Spaziale
        if (turf.pointToLineDistance(pStart, route) > TOLLERANZA_KM || 
            turf.pointToLineDistance(pEnd, route) > TOLLERANZA_KM) continue;

        // 2. Filtro Direzione
        const startIdx = turf.nearestPointOnLine(route, pStart).properties.index;
        const endIdx = turf.nearestPointOnLine(route, pEnd).properties.index;
        if (endIdx - startIdx < 0.1) continue; 

        // 3. Calcolo Disponibilità (Unica fonte di verità)
        const prenotazioni = prenotazioniBatch[i] || [];
        const postiDisponibili = calcolaPostiDisponibiliSuTratta(c, startIdx, endIdx, prenotazioni);

        // 4. Convalida
        if (postiDisponibili >= richiesta.posti_richiesti) {
            // Iniettiamo il valore calcolato nell'oggetto corsa
            corseValide.push({ 
                ...c, 
                postiDisponibili, 
                startIdx, 
                endIdx 
            });
        }
    }
    return { corse: corseValide };
}

export function filterSlotOnly(richiesta, allSlots) {
    return allSlots.filter(s => s.disponibile && (s.posti_totali >= richiesta.posti_richiesti));
}