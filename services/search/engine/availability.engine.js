import * as turf from '@turf/turf';

/**
 * Helper ottimizzato: garantisce sempre un indice valido
 */
function getSnapResult(route, point, tolleranzaKm, corsa) {
    // 1. Logica Nodi Predefiniti
    if (corsa.tipo_corsa === 'riempimento' && corsa.fermate_pianificate?.nodi) {
        let nearestNode = null;
        let minDistance = tolleranzaKm;

        for (const nodo of corsa.fermate_pianificate.nodi) {
            if (!nodo.coord) continue;
            const dist = turf.distance(point, turf.point(nodo.coord), { units: 'kilometers' });
            if (dist < minDistance) {
                minDistance = dist;
                nearestNode = {
                    geometry: { coordinates: nodo.coord },
                    properties: { index: nodo.index }
                };
            }
        }
        return nearestNode;
    }

    // 2. Comportamento Standard con fallback indice sicuro
    if (!route) return null;
    const nearest = turf.nearestPointOnLine(route, point);
    const dist = turf.distance(point, nearest, { units: 'kilometers' });
    
    if (dist <= tolleranzaKm) {
        return {
            ...nearest,
            properties: { 
                ...nearest.properties, 
                // Se manca l'indice, forziamo 0 per evitare undefined critici
                index: nearest.properties.index ?? 0 
            }
        };
    }
    return null;
}

/**
 * Motore di ricerca ottimizzato con protezione dati
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    if (!richiesta.coord || !richiesta.coordDest) return { corse: [] };

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    const TOLLERANZA_KM = 0.5; 
    const MIN_DIST_FUSIONE = 0.4; 
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    const corseValide = corseCandidate.filter((c, index) => {
        if (!c.decodedCoords || c.decodedCoords.length < 2) return false;

        const route = turf.lineString(c.decodedCoords);
        let startSnap = getSnapResult(route, pStart, TOLLERANZA_KM, c);
        let endSnap = getSnapResult(route, pEnd, TOLLERANZA_KM, c);

        // Protezione contro dati mancanti
        if (!startSnap?.properties || !endSnap?.properties) return false;

        let isFusione = false;
        
        if (c.tipo_corsa === 'condivisa') {
            const esistenti = c.fermate_pianificate?.nodi || [];
            const maxFermate = c.max_fermate_consentite || 5;

            const salitaVicina = esistenti.find(f => f.coord && turf.distance(startSnap.geometry.coordinates, f.coord) < MIN_DIST_FUSIONE);
            if (salitaVicina) {
                startSnap.properties.index = salitaVicina.index;
                isFusione = true;
            } else if (esistenti.length >= maxFermate) return false;

            const discesaVicina = esistenti.find(f => f.coord && turf.distance(endSnap.geometry.coordinates, f.coord) < MIN_DIST_FUSIONE);
            if (discesaVicina) {
                endSnap.properties.index = discesaVicina.index;
                isFusione = true;
            } else if (esistenti.length + (salitaVicina ? 0 : 1) >= maxFermate) return false;
        }

        const startIdx = Number(startSnap.properties.index);
        const endIdx = Number(endSnap.properties.index);
        
        if (endIdx <= startIdx) return false;

        // Verifica disponibilità atomica
        const prenotazioni = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
        const isDisponibile = verificaDisponibilitaInMemoria(c, startIdx, endIdx, postiRichiesti, prenotazioni);

        if (isDisponibile) {
            c.startIdx = startIdx;
            c.endIdx = endIdx;
            c.fermataSalita = startSnap.geometry.coordinates;
            c.fermataDiscesa = endSnap.geometry.coordinates;
            c.is_nodo_predefinito = (c.tipo_corsa === 'riempimento');
            c.fermata_fusione = isFusione;
            return true;
        }
        return false;
    });

    return { corse: corseValide };
}

/**
 * Ottimizzazione: verifica con break immediato per ridurre cicli CPU
 */
function verificaDisponibilitaInMemoria(corsa, startIdx, endIdx, postiRichiesti, prenotazioni) {
    const postiTotali = Number(corsa.posti_totali || 0);
    
    // Ottimizzazione: non ciclare su tutto, verifica segmento per segmento in modo reattivo
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