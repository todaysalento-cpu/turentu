import * as turf from '@turf/turf';
import { CacheStore } from '../search.cache.js';

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
        
        if (distStart > TOLLERANZA_KM || distEnd > TOLLERANZA_KM) { 
            stats.d++; continue; 
        }

        const startPointOnLine = turf.nearestPointOnLine(route, pStart);
        const endPointOnLine = turf.nearestPointOnLine(route, pEnd);
        
        // Indici per calcolare la sovrapposizione dei segmenti
        const startIdx = startPointOnLine.properties.index;
        const endIdx = endPointOnLine.properties.index;
        const idxDiff = endIdx - startIdx;
        
        if (idxDiff < 0.5) { 
            stats.dir++; continue; 
        }

        // --- NUOVA LOGICA: Calcolo Picco di Occupazione ---
        const prenotazioni = Array.isArray(prenotazioniData[i]) ? prenotazioniData[i] : [];
        
        // Funzione per calcolare il numero massimo di posti occupati contemporaneamente
        // nel segmento [startIdx, endIdx]
        let maxOccupazioneSulSegmento = 0;
        
        // Verifichiamo il carico in ogni punto del segmento richiesto
        // (Per efficienza, controlliamo solo i punti di inizio/fine delle prenotazioni esistenti)
        const puntiCritici = new Set([startIdx, endIdx]);
        prenotazioni.forEach(p => {
            if (p.start_index_polyline > startIdx && p.start_index_polyline < endIdx) puntiCritici.add(p.start_index_polyline);
            if (p.end_index_polyline > startIdx && p.end_index_polyline < endIdx) puntiCritici.add(p.end_index_polyline);
        });

        for (let punto of puntiCritici) {
            let occupazioneAlPunto = prenotazioni.reduce((acc, p) => {
                // Se la prenotazione esistente copre questo punto, aggiungila al carico
                if (punto >= p.start_index_polyline && punto < p.end_index_polyline) {
                    return acc + (Number(p?.posti_richiesti) || 0);
                }
                return acc;
            }, 0);
            if (occupazioneAlPunto > maxOccupazioneSulSegmento) maxOccupazioneSulSegmento = occupazioneAlPunto;
        }

        const postiLiberi = Number(c.posti_totali || 0) - maxOccupazioneSulSegmento;

        if (postiLiberi >= postiRichiesti) {
            c.postiDisponibili = postiLiberi;
            corseValide.push(c);
        } else { 
            stats.p++; 
        }
    }

    console.log(`[FILTER-CORSE] ${corseValide.length} ok | Scarti: D=${stats.d} Dir=${stats.dir} P=${stats.p} (${Date.now() - startTime}ms)`);
    
    return { slots: corseValide.map(c => ({ /* ... */ })), corse: corseValide };
}