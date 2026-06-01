import * as turf from '@turf/turf';
import { CacheStore } from '../search.cache.js';

/**
 * Filtra le corse esistenti in base alla disponibilità spaziale e temporale
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniData) {
    const startTime = Date.now();
    const corseValide = [];
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);
    
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    const TOLLERANZA_KM = 50; 
    let stats = { d: 0, dir: 0, p: 0 };

    for (let i = 0; i < corseCandidate.length; i++) {
        const c = corseCandidate[i];
        if (!c?.decodedCoords || c.decodedCoords.length < 2) continue;

        const route = turf.lineString(c.decodedCoords);
        const distStart = turf.pointToLineDistance(pStart, route, { units: 'kilometers' });
        const distEnd = turf.pointToLineDistance(pEnd, route, { units: 'kilometers' });
        
        // Filtro Spaziale: Scarta se i punti sono fuori tolleranza
        if (distStart > TOLLERANZA_KM || distEnd > TOLLERANZA_KM) { 
            stats.d++; continue; 
        }

        const startPointOnLine = turf.nearestPointOnLine(route, pStart);
        const endPointOnLine = turf.nearestPointOnLine(route, pEnd);
        
        const startIdx = startPointOnLine.properties.index;
        const endIdx = endPointOnLine.properties.index;
        
        // Filtro Direzione: Scarta se la tratta è troppo breve o invertita
        if (endIdx - startIdx < 0.5) { 
            stats.dir++; continue; 
        }

        const prenotazioni = Array.isArray(prenotazioniData[i]) ? prenotazioniData[i] : [];
        let maxOccupazioneSulSegmento = 0;
        
        // --- MECCANISMO DI SICUREZZA (FALLBACK GEOMETRICO) ---
        const puntiCritici = new Set([startIdx, endIdx]);
        
        prenotazioni.forEach(p => {
            // Se gli indici mancano o sono nulli, calcoliamo la posizione reale sulla linea
            let sIdx = p.start_index_polyline;
            let eIdx = p.end_index_polyline;

            if (sIdx == null || eIdx == null) {
                const pS = turf.point([Number(p.lon_salita), Number(p.lat_salita)]);
                const pD = turf.point([Number(p.lon_discesa), Number(p.lat_discesa)]);
                sIdx = turf.nearestPointOnLine(route, pS).properties.index;
                eIdx = turf.nearestPointOnLine(route, pD).properties.index;
            }

            if (sIdx > startIdx && sIdx < endIdx) puntiCritici.add(sIdx);
            if (eIdx > startIdx && eIdx < endIdx) puntiCritici.add(eIdx);
            
            // Memorizziamo temporaneamente per il calcolo
            p._sIdx = sIdx;
            p._eIdx = eIdx;
        });

        // Calcolo occupazione reale sul segmento
        for (let punto of puntiCritici) {
            let occupazioneAlPunto = prenotazioni.reduce((acc, p) => {
                if (punto >= p._sIdx && punto < p._eIdx) {
                    return acc + (Number(p?.posti_richiesti) || 0);
                }
                return acc;
            }, 0);
            
            if (occupazioneAlPunto > maxOccupazioneSulSegmento) {
                maxOccupazioneSulSegmento = occupazioneAlPunto;
            }
        }

        const postiLiberi = Number(c.posti_totali || 0) - maxOccupazioneSulSegmento;

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        } else { 
            stats.p++; 
        }
    }

    console.log(`[FILTER-CORSE] ${corseValide.length} validi | Scarti: D=${stats.d} Dir=${stats.dir} P=${stats.p} (${Date.now() - startTime}ms)`);
    
    return { slots: corseValide.map(c => ({ ...c })), corse: corseValide };
}

/**
 * Filtra gli slot generici basandosi sui posti richiesti
 */
export function filterSlotOnly(richiesta, allSlots) {
    if (!Array.isArray(allSlots)) return [];
    return allSlots.filter(s => s.disponibile && (s.posti_totali >= richiesta.posti_richiesti));
}