import * as turf from '@turf/turf';

/**
 * Helper ottimizzato: garantisce sempre un indice valido
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
    if (dist <= tolleranzaKm) {
        return { ...nearest, properties: { ...nearest.properties, index: nearest.properties.index ?? 0 } };
    }
    return null;
}

/**
 * Motore di ricerca aggiornato: supporta pool di veicoli per Pop Bus
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch, poolVeicoliDisponibili = []) {
    if (!richiesta.coord || !richiesta.coordDest) return { corse: [] };

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    const TOLLERANZA_KM = 0.5; 
    const MIN_DIST_FUSIONE = 0.4; 
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    const corseValide = corseCandidate.filter((c, index) => {
        // Se è un pop-bus 'da_attivare', usiamo la logica di pool aggregato
        if (c.tipo_corsa === 'pop-bus' && c.stato === 'da_attivare') {
            return verificaDisponibilitaPool(poolVeicoliDisponibili, postiRichiesti);
        }

        if (!c.decodedCoords || c.decodedCoords.length < 2) return false;

        const route = turf.lineString(c.decodedCoords);
        let startSnap = getSnapResult(route, pStart, TOLLERANZA_KM, c);
        let endSnap = getSnapResult(route, pEnd, TOLLERANZA_KM, c);

        if (!startSnap?.properties || !endSnap?.properties) return false;

        // Logica Fusione invariata per corse rigide
        const startIdx = Number(startSnap.properties.index);
        const endIdx = Number(endSnap.properties.index);
        if (endIdx <= startIdx) return false;

        const prenotazioni = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
        const isDisponibile = verificaDisponibilitaInMemoria(c, startIdx, endIdx, postiRichiesti, prenotazioni);

        if (isDisponibile) {
            c.startIdx = startIdx;
            c.endIdx = endIdx;
            c.fermataSalita = startSnap.geometry.coordinates;
            c.fermataDiscesa = endSnap.geometry.coordinates;
            c.is_nodo_predefinito = (c.tipo_corsa === 'riempimento' || c.tipo_corsa === 'pop-bus');
            return true;
        }
        return false;
    });

    return { corse: corseValide };
}

/**
 * Nuova logica: calcolo disponibilità su Pool Aggregato
 */
function verificaDisponibilitaPool(poolVeicoli, postiRichiesti) {
    // Capacità totale del pool = somma posti di tutti i veicoli disponibili
    const capacitaTotalePool = poolVeicoli.reduce((sum, v) => sum + Number(v.posti_totali || 0), 0);
    // In un modello di pool, il sistema è disponibile se c'è spazio fisico totale
    return capacitaTotalePool >= postiRichiesti;
}

/**
 * Verifica saturazione per corse singole (Private/Condivise)
 */
function verificaDisponibilitaInMemoria(corsa, startIdx, endIdx, postiRichiesti, prenotazioni) {
    const postiTotali = Number(corsa.posti_totali || 0);
    for (let i = startIdx; i < endIdx; i++) {
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

export function filterSlotOnly(richiesta, slots) {
    return (slots || []).filter(s => 
        s.disponibile === true && 
        Number(s.posti_totali || 0) >= Number(richiesta.posti_richiesti || 0)
    );
}