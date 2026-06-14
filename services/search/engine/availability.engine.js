import * as turf from '@turf/turf';

/**
 * Cerca il nodo più vicino (Statico) O crea un punto sulla linea (Dinamico)
 */
function getSnapResult(point, corsa, tolleranzaKm) {
    // 1. TENTATIVO STATICO (Nodo nel database)
    if (corsa.nodi && corsa.nodi.length > 0) {
        let nearestNode = null;
        let minDistance = tolleranzaKm;

        for (const nodo of corsa.nodi) {
            if (!nodo.coord) continue;
            const dist = turf.distance(point, turf.point(nodo.coord), { units: 'kilometers' });
            if (dist < minDistance) {
                minDistance = dist;
                nearestNode = { ...nodo, type: 'STATIC', dist };
            }
        }
        if (nearestNode) return nearestNode;
    }

    // 2. FALLBACK DINAMICO (Punto virtuale su Polyline)
    if (corsa.polyline) {
        const line = turf.lineString(corsa.polyline); // Assicurati sia un formato compatibile
        const snapped = turf.nearestPointOnLine(line, point, { units: 'kilometers' });
        
        if (snapped.properties.dist < tolleranzaKm) {
            return {
                id: null,
                offset_metri: snapped.properties.location * 1000,
                type: 'DYNAMIC',
                dist: snapped.properties.dist
            };
        }
    }

    return null; // Fuori portata
}

/**
 * Motore di validazione ibrido (Statico + Dinamico)
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    console.log(`🔍 [ENGINE] Inizio filtraggio ibrido su ${corseCandidate.length} candidate.`);

    if (!richiesta.coord || !richiesta.coordDest) return { corse: [] };

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 2.0; 
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    const corseValide = corseCandidate.filter((c, index) => {
        if (c.tipo_corsa === 'pop-bus') return false;
        
        // 1. Snap ibrido (Nodo o Virtuale)
        const startSnap = getSnapResult(pStart, c, TOLLERANZA_KM);
        const endSnap = getSnapResult(pEnd, c, TOLLERANZA_KM);

        if (!startSnap || !endSnap) {
            return false;
        }

        // 2. Calcolo Offset
        const startOffset = Number(startSnap.offset_metri);
        const endOffset = Number(endSnap.offset_metri);
        
        // Direzione coerente
        if (startOffset >= endOffset) return false;

        c.distanza = Math.abs(endOffset - startOffset);
        
        // 3. Verifica Saturazione
        const prenotazioni = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
        return verificaSaturazioneOffset(c, startOffset, endOffset, postiRichiesti, prenotazioni);
    });

    return { corse: corseValide };
}

function verificaSaturazioneOffset(corsa, startO, endO, postiRichiesti, prenotazioni) {
    const postiTotali = Number(corsa.posti_totali || 8);
    
    for (const p of prenotazioni) {
        const pStart = Number(p.startOffset);
        const pEnd = Number(p.endOffset);
        
        // Sovrapposizione segmenti
        if (startO < pEnd && endO > pStart) {
            if ((Number(p.posti_richiesti) + postiRichiesti) > postiTotali) return false;
        }
    }
    return true;
}