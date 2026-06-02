import * as turf from '@turf/turf';

/**
 * Motore di calcolo occupazione: determina i posti liberi e occupati su un segmento specifico
 */
function calcolaOccupazioneSuTratta(corsa, startIdx, endIdx, prenotazioniRaw) {
    // 1. Parsing sicuro dei dati provenienti da Redis
    const prenotazioni = prenotazioniRaw.map(p => {
        try {
            // Se è già un oggetto (magari da una cache in memoria), lo teniamo; altrimenti parsiamo
            return typeof p === 'string' ? JSON.parse(p) : p;
        } catch (e) {
            console.error("Errore parse prenotazione:", e);
            return null;
        }
    }).filter(Boolean);

    const puntiCritici = new Set([startIdx, endIdx]);
    
    // Identifichiamo i punti dove cambia l'occupazione lungo il tragitto
    prenotazioni.forEach(p => {
        const sIdx = p.start_index_polyline ?? 0;
        const eIdx = p.end_index_polyline ?? (corsa.decodedCoords ? corsa.decodedCoords.length : 0);
        if (sIdx > startIdx && sIdx < endIdx) puntiCritici.add(sIdx);
        if (eIdx > startIdx && eIdx < endIdx) puntiCritici.add(eIdx);
    });

    let maxOccupazione = 0;
    
    // Calcoliamo l'occupazione per ogni segmento critico
    for (let punto of puntiCritici) {
        const occupazioneAlPunto = prenotazioni.reduce((acc, p) => {
            const sIdx = p.start_index_polyline ?? 0;
            const eIdx = p.end_index_polyline ?? (corsa.decodedCoords ? corsa.decodedCoords.length : 0);
            
            // Se la prenotazione copre il punto, sommiamo i posti
            if (punto >= sIdx && punto < eIdx) {
                return acc + (Number(p.posti_richiesti) || 0);
            }
            return acc;
        }, 0);
        
        if (occupazioneAlPunto > maxOccupazione) maxOccupazione = occupazioneAlPunto;
    }

    const postiTotali = Number(corsa.posti_totali || 0);
    return {
        postiDisponibili: Math.max(0, postiTotali - maxOccupazione),
        postiPrenotati: maxOccupazione
    };
}

/**
 * Filtra le corse basandosi sulla disponibilità spaziale, temporale e di posti
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    const corseValide = [];
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    const reqDate = new Date(richiesta.start_datetime).toDateString();
    const TOLLERANZA_KM = 150; 

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        if (!c.decodedCoords || c.decodedCoords.length < 2) continue;

        // 1. FILTRO TEMPORALE
        const corsaDate = new Date(c.start_datetime || c.oraPartenza).toDateString();
        if (corsaDate !== reqDate) continue;

        // 2. FILTRO SPAZIALE
        const route = turf.lineString(c.decodedCoords);
        const distStart = turf.pointToLineDistance(pStart, route);
        const distEnd = turf.pointToLineDistance(pEnd, route);
        
        if (distStart > TOLLERANZA_KM || distEnd > TOLLERANZA_KM) continue;

        // 3. FILTRO DIREZIONE
        const startIdx = turf.nearestPointOnLine(route, pStart).properties.index;
        const endIdx = turf.nearestPointOnLine(route, pEnd).properties.index;
        
        if (endIdx <= startIdx) continue; 

        // 4. CALCOLO DISPONIBILITÀ (Passiamo l'array corretto estratto dal batch)
        const prenotazioni = prenotazioniBatch[i] || [];
        const { postiDisponibili, postiPrenotati } = calcolaOccupazioneSuTratta(c, startIdx, endIdx, prenotazioni);

        if (postiDisponibili >= richiesta.posti_richiesti) {
            corseValide.push({ 
                ...c, 
                postiDisponibili, 
                postiPrenotati, 
                startIdx, 
                endIdx 
            });
        }
    }
    
    console.log(`[ENGINE] Ricerca completata per ${reqDate}: trovate ${corseValide.length} corse valide.`);
    return { corse: corseValide };
}

export function filterSlotOnly(richiesta, allSlots) {
    return allSlots.filter(s => s.disponibile && (s.posti_totali >= richiesta.posti_richiesti));
}