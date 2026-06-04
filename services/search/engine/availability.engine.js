import * as turf from '@turf/turf';

/**
 * Helper per snap su linea o nodi specifici
 */
function getSnapResult(route, point, tolleranzaKm, corsa) {
    if ((corsa.tipo_corsa === 'riempimento' || corsa.tipo_corsa === 'pop-bus') && corsa.fermate_pianificate?.nodi) {
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
 * Motore di ricerca aggiornato con calcolo distanza reale
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    if (!richiesta.coord || !richiesta.coordDest) return { corse: [] };

    console.log(`🔍 [ENGINE] Inizio analisi su ${corseCandidate.length} corse.`);

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 2.0; 
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    const corseValide = corseCandidate.filter((c, index) => {
        if (c.tipo_corsa === 'pop-bus') return false;
        if (!c.decodedCoords || c.decodedCoords.length < 2) return false;

        const route = turf.lineString(c.decodedCoords);
        const startSnap = getSnapResult(route, pStart, TOLLERANZA_KM, c);
        const endSnap = getSnapResult(route, pEnd, TOLLERANZA_KM, c);

        if (!startSnap?.properties || !endSnap?.properties) return false;

        // 🟢 CALCOLO DISTANZA REALE (Geometria su polilinea)
        // Utilizziamo lineSlice per estrarre esattamente il pezzo di rotta tra i due punti
        const slicedRoute = turf.lineSlice(startSnap, endSnap, route);
        const distanzaRealeMetri = turf.length(slicedRoute, { units: 'meters' });
        
        // Inseriamo la distanza calcolata direttamente nell'oggetto corsa
        c.distanza = Math.round(distanzaRealeMetri);

        const startIdx = Number(startSnap.properties.index);
        const endIdx = Number(endSnap.properties.index);
        
        console.log(`   ✅ [CORSA ${c.id}] Snap OK | Indici: ${startIdx}->${endIdx} | Distanza: ${(c.distanza/1000).toFixed(2)} km`);
        
        const prenotazioni = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
        return verificaDisponibilitaInMemoria(c, startIdx, endIdx, postiRichiesti, prenotazioni);
    });

    return { corse: corseValide };
}

/**
 * Verifica saturazione segmentata
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
        if ((occupazioneSegmento + postiRichiesti) > postiTotali) return false;
    }
    return true;
}