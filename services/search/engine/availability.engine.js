import * as turf from '@turf/turf';

/**
 * Cerca il nodo più vicino tra quelli definiti per la direttrice.
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
 * Motore di validazione Node-Based arricchito con logging per debug.
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    console.log(`🔍 [ENGINE] Inizio filtraggio su ${corseCandidate.length} candidate.`);

    if (!richiesta.coord || !richiesta.coordDest) {
        console.warn("⚠️ [ENGINE] Coordinate mancanti.");
        return { corse: [] };
    }

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 2.0; 
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    const corseValide = corseCandidate.filter((c, index) => {
        // 1. Check Tipo Corsa
        if (c.tipo_corsa === 'pop-bus') return false;
        
        // 2. Check Nodi
        if (!c.nodi || c.nodi.length < 2) {
            console.log(`❌ [CORSA ${c.id}] Scartata: Nodi insufficienti o mancanti.`);
            return false;
        }

        // 3. Snap Geografico
        const startSnap = getSnapResult(pStart, c.nodi, TOLLERANZA_KM);
        const endSnap = getSnapResult(pEnd, c.nodi, TOLLERANZA_KM);

        if (!startSnap || !endSnap) {
            console.log(`❌ [CORSA ${c.id}] Scartata: Geofencing fallito (fuori tolleranza ${TOLLERANZA_KM}km).`);
            return false;
        }

        // 4. Calcolo Offset e Saturazione
        const startOffset = Number(startSnap.offset_metri);
        const endOffset = Number(endSnap.offset_metri);
        c.distanza = Math.abs(endOffset - startOffset);
        
        const prenotazioni = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
        const isDisponibile = verificaSaturazioneOffset(c, startOffset, endOffset, postiRichiesti, prenotazioni);
        
        if (isDisponibile) {
            console.log(`✅ [CORSA ${c.id}] IDONEA | Dist: ${(c.distanza/1000).toFixed(2)}km`);
            return true;
        } else {
            console.log(`❌ [CORSA ${c.id}] Scartata: Saturata nel segmento.`);
            return false;
        }
    });

    console.log(`📡 [ENGINE] Filtro completato. Corse valide trovate: ${corseValide.length}`);
    return { corse: corseValide };
}

/**
 * Verifica saturazione basata su intervalli di offset (metri).
 */
function verificaSaturazioneOffset(corsa, startO, endO, postiRichiesti, prenotazioni) {
    const postiTotali = Number(corsa.posti_totali || 8); // Default 8 se non definito
    const s = Math.min(startO, endO);
    const e = Math.max(startO, endO);

    // Debug saturazione
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