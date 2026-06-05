import * as turf from '@turf/turf';

/**
 * Helper per snap su linea o nodi specifici
 */
function getSnapResult(route, point, tolleranzaKm, corsa) {
    // Gestione nodi solo per corse di tipo 'riempimento'
    if (corsa.tipo_corsa === 'riempimento' && corsa.fermate_pianificate?.nodi) {
        let nearestNode = null;
        let minDistance = tolleranzaKm;
        for (const nodo of corsa.fermate_pianificate.nodi) {
            if (!nodo.coord) continue;
            const dist = turf.distance(point, turf.point(nodo.coord), { units: 'kilometers' });
            if (dist < minDistance) {
                minDistance = dist;
                nearestNode = { geometry: { coordinates: nodo.coord }, properties: { index: nodo.index } };
            }
        }
        return nearestNode;
    }
    
    if (!route) return null;
    const nearest = turf.nearestPointOnLine(route, point);
    const dist = turf.distance(point, nearest, { units: 'kilometers' });
    
    return dist <= tolleranzaKm 
        ? { ...nearest, properties: { ...nearest.properties, index: nearest.properties.index ?? 0 } } 
        : null;
}

/**
 * Motore dedicato alla validazione delle sole corse di linea (condivise).
 * Il Pop Bus è ora gestito esternamente in cercaSlotUltra.js.
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    if (!richiesta.coord || !richiesta.coordDest) {
        console.warn("⚠️ [ENGINE] Coordinate mancanti nella richiesta.");
        return { corse: [] };
    }

    console.log(`🔍 [ENGINE] Inizio analisi su ${corseCandidate.length} corse di linea.`);

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 2.0; 
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    const corseValide = corseCandidate.filter((c, index) => {
        // ESCLUSIONE: le corse 'pop-bus' non vanno processate qui
        if (c.tipo_corsa === 'pop-bus') return false; 

        if (!c.decodedCoords || c.decodedCoords.length < 2) {
            console.log(`❌ [CORSA ${c.id}] Scartata: Geometria non valida.`);
            return false;
        }

        const route = turf.lineString(c.decodedCoords);
        const startSnap = getSnapResult(route, pStart, TOLLERANZA_KM, c);
        const endSnap = getSnapResult(route, pEnd, TOLLERANZA_KM, c);

        if (!startSnap?.properties || !endSnap?.properties) {
            console.log(`❌ [CORSA ${c.id}] Scartata: Fuori tolleranza (${TOLLERANZA_KM}km).`);
            return false;
        }

        const slicedRoute = turf.lineSlice(startSnap, endSnap, route);
        c.distanza = Math.round(turf.length(slicedRoute, { units: 'meters' }));
        
        const startIdx = Number(startSnap.properties.index);
        const endIdx = Number(endSnap.properties.index);
        
        const prenotazioni = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
        const isDisponibile = verificaDisponibilitaInMemoria(c, startIdx, endIdx, postiRichiesti, prenotazioni);
        
        if (isDisponibile) {
            console.log(`✅ [CORSA ${c.id}] IDONEA | Tipo: ${c.tipo_corsa} | Dist: ${(c.distanza/1000).toFixed(2)}km`);
            return true;
        } else {
            console.log(`⚠️ [CORSA ${c.id}] Disponibile: NO (Saturazione raggiunta).`);
            return false;
        }
    });

    return { corse: corseValide };
}

/**
 * Verifica saturazione con log di dettaglio
 */
function verificaDisponibilitaInMemoria(corsa, startIdx, endIdx, postiRichiesti, prenotazioni) {
    const postiTotali = Number(corsa.posti_totali || 0);
    const s = Math.min(startIdx, endIdx);
    const e = Math.max(startIdx, endIdx);

    for (let i = s; i < e; i++) {
        let occupazioneSegmento = 0;
        for (const p of prenotazioni) {
            if (Number(p.startIdx) <= i && Number(p.endIdx) > i) {
                occupazioneSegmento += Number(p.posti_richiesti);
            }
        }
        if ((occupazioneSegmento + postiRichiesti) > postiTotali) {
            console.log(`🔍 [DEBUG SATURAZIONE] Segmento ${i} pieno per corsa ${corsa.id}. (Occupato: ${occupazioneSegmento}/${postiTotali})`);
            return false;
        }
    }
    return true;
}