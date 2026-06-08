import * as turf from '@turf/turf';

/**
 * Cerca il nodo più vicino tra quelli definiti per la direttrice.
 * @param {object} point - Punto Turf dell'utente
 * @param {Array} nodi - Array di oggetti con {offset_metri, coord: [lon, lat]}
 * @param {number} tolleranzaKm 
 */
function getSnapResult(point, nodi, tolleranzaKm) {
    let nearestNode = null;
    let minDistance = tolleranzaKm;

    for (const nodo of nodi) {
        if (!nodo.coord) continue;
        const dist = turf.distance(point, turf.point(nodo.coord), { units: 'kilometers' });
        if (dist < minDistance) {
            minDistance = dist;
            nearestNode = nodo;
        }
    }
    return nearestNode;
}

/**
 * Motore di validazione Node-Based.
 * Utilizza offset_metri per calcoli istantanei di distanza e saturazione.
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    if (!richiesta.coord || !richiesta.coordDest) {
        console.warn("⚠️ [ENGINE] Coordinate mancanti.");
        return { corse: [] };
    }

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 2.0; 
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    const corseValide = corseCandidate.filter((c, index) => {
        // Pop-bus gestiti esternamente: qui validiamo solo linee con nodi predefiniti
        if (c.tipo_corsa === 'pop-bus' || !c.nodi || c.nodi.length < 2) return false;

        const startSnap = getSnapResult(pStart, c.nodi, TOLLERANZA_KM);
        const endSnap = getSnapResult(pEnd, c.nodi, TOLLERANZA_KM);

        if (!startSnap || !endSnap) return false;

        // Calcolo distanza basato su differenza di offset (preciso al metro)
        const startOffset = Number(startSnap.offset_metri);
        const endOffset = Number(endSnap.offset_metri);
        c.distanza = Math.abs(endOffset - startOffset);
        
        const prenotazioni = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
        const isDisponibile = verificaSaturazioneOffset(c, startOffset, endOffset, postiRichiesti, prenotazioni);
        
        if (isDisponibile) {
            console.log(`✅ [CORSA ${c.id}] IDONEA | Dist: ${(c.distanza/1000).toFixed(2)}km`);
            return true;
        }
        return false;
    });

    return { corse: corseValide };
}

/**
 * Verifica saturazione basata su intervalli di offset (metri).
 * Non usa più indici di array, ma confronto numerico tra range.
 */
function verificaSaturazioneOffset(corsa, startO, endO, postiRichiesti, prenotazioni) {
    const postiTotali = Number(corsa.posti_totali || 0);
    const s = Math.min(startO, endO);
    const e = Math.max(startO, endO);

    // Un segmento è saturo se in qualsiasi punto del tragitto 
    // la somma dei posti prenotati eccede la capacità.
    for (const p of prenotazioni) {
        const pStart = Number(p.startOffset);
        const pEnd = Number(p.endOffset);
        
        // Controllo sovrapposizione tra segmenti [s, e] e [pStart, pEnd]
        if (s < pEnd && e > pStart) {
            const occupazioneCorrente = Number(p.posti_richiesti);
            if ((occupazioneCorrente + postiRichiesti) > postiTotali) {
                console.log(`🔍 [DEBUG SATURAZIONE] Tratto ${s}m-${e}m saturo per corsa ${corsa.id}.`);
                return false;
            }
        }
    }
    return true;
}