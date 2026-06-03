import * as turf from '@turf/turf';

/**
 * Helper per agganciare la posizione alla polilinea o ai nodi predefiniti
 */
function getSnapResult(route, point, tolleranzaKm, corsa) {
    // 1. Logica Nodi Predefiniti (Prioritaria per corse evento/riempimento)
    if (corsa.tipo_corsa === 'riempimento' && corsa.fermate_pianificate?.nodi) {
        let nearestNode = null;
        let minDistance = tolleranzaKm;

        for (const nodo of corsa.fermate_pianificate.nodi) {
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

    // 2. Comportamento Standard (Snap-to-Route generico)
    const nearest = turf.nearestPointOnLine(route, point);
    const dist = turf.distance(point, nearest, { units: 'kilometers' });
    return dist <= tolleranzaKm ? nearest : null;
}

/**
 * Motore di ricerca ottimizzato (Batch Processing)
 * @param {Object} richiesta - Richiesta utente
 * @param {Array} corseCandidate - Corse pre-filtrate geograficamente
 * @param {Array} prenotazioniBatch - Array di array di prenotazioni già fetched
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    const corseValide = [];
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    const TOLLERANZA_KM = 0.5; 
    const MIN_DIST_FUSIONE = 0.4; 

    corseCandidate.forEach((c, index) => {
        if (!c.decodedCoords || c.decodedCoords.length < 2) return;

        const route = turf.lineString(c.decodedCoords);
        let startSnap = getSnapResult(route, pStart, TOLLERANZA_KM, c);
        let endSnap = getSnapResult(route, pEnd, TOLLERANZA_KM, c);

        if (!startSnap || !endSnap) return;

        let isFusione = false;
        
        // Logica Condivisa: Fusione o Validazione
        if (c.tipo_corsa === 'condivisa') {
            const esistenti = c.fermate_pianificate?.nodi || [];
            const maxFermate = c.max_fermate_consentite || 5;

            const salitaVicina = esistenti.find(f => turf.distance(startSnap.geometry.coordinates, f.coord) < MIN_DIST_FUSIONE);
            if (salitaVicina) {
                startSnap.properties.index = salitaVicina.index;
                isFusione = true;
            } else if (esistenti.length >= maxFermate) return;

            const discesaVicina = esistenti.find(f => turf.distance(endSnap.geometry.coordinates, f.coord) < MIN_DIST_FUSIONE);
            if (discesaVicina) {
                endSnap.properties.index = discesaVicina.index;
                isFusione = true;
            } else if (esistenti.length + (salitaVicina ? 0 : 1) >= maxFermate) return;
        }

        const startIdx = startSnap.properties.index;
        const endIdx = endSnap.properties.index;
        if (endIdx <= startIdx) return;

        // VALIDAZIONE ATOMICA IN MEMORIA
        // Utilizziamo le prenotazioniBatch caricate precedentemente nel servizio principale
        const prenotazioniCorsa = prenotazioniBatch[index] || [];
        const isDisponibile = verificaDisponibilitaInMemoria(c, startIdx, endIdx, richiesta.posti_richiesti, prenotazioniCorsa);

        if (isDisponibile) {
            corseValide.push({ 
                ...c, 
                startIdx, 
                endIdx,
                fermataSalita: startSnap.geometry.coordinates,
                fermataDiscesa: endSnap.geometry.coordinates,
                is_nodo_predefinito: (c.tipo_corsa === 'riempimento'),
                fermata_fusione: isFusione
            });
        }
    });

    return { corse: corseValide };
}

/**
 * Logica di controllo posti occupati nel segmento
 */
function verificaDisponibilitaInMemoria(corsa, startIdx, endIdx, postiRichiesti, prenotazioni) {
    // 1. Somma posti occupati in ogni segmento del range richiesto
    for (let i = startIdx; i < endIdx; i++) {
        const occupazioneSegmento = prenotazioni.reduce((acc, p) => {
            // Se la prenotazione esistente sovrappone il segmento i
            if (p.startIdx <= i && p.endIdx > i) return acc + p.posti_richiesti;
            return acc;
        }, 0);

        if ((occupazioneSegmento + postiRichiesti) > corsa.posti_totali) return false;
    }
    return true;
}

export function filterSlotOnly(richiesta, slots) {
    return slots.filter(s => s.disponibile && s.posti_totali >= richiesta.posti_richiesti);
}