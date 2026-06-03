import * as turf from '@turf/turf';

/**
 * Helper per agganciare la posizione alla polilinea o ai nodi predefiniti
 * Aggiunta protezione per coordinate mancanti.
 */
function getSnapResult(route, point, tolleranzaKm, corsa) {
    // 1. Logica Nodi Predefiniti (Prioritaria per corse riempimento/evento)
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

    // 2. Comportamento Standard (Snap-to-Route generico)
    if (!route) return null;
    const nearest = turf.nearestPointOnLine(route, point);
    const dist = turf.distance(point, nearest, { units: 'kilometers' });
    return dist <= tolleranzaKm ? nearest : null;
}

/**
 * Motore di ricerca ottimizzato (Batch Processing in memoria)
 * Aggiunta protezione per gestire dati parziali nelle corse candidate.
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    const corseValide = [];
    
    // Validazione input sicurezza
    if (!richiesta.coord || !richiesta.coordDest) return { corse: [] };

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    const TOLLERANZA_KM = 0.5; 
    const MIN_DIST_FUSIONE = 0.4; 

    corseCandidate.forEach((c, index) => {
        // Controllo robustezza dati corsa
        if (!c.decodedCoords || !Array.isArray(c.decodedCoords) || c.decodedCoords.length < 2) return;

        const route = turf.lineString(c.decodedCoords);
        let startSnap = getSnapResult(route, pStart, TOLLERANZA_KM, c);
        let endSnap = getSnapResult(route, pEnd, TOLLERANZA_KM, c);

        if (!startSnap || !endSnap || startSnap.properties.index === undefined || endSnap.properties.index === undefined) return;

        let isFusione = false;
        
        // Logica Condivisa: Fusione o Validazione
        if (c.tipo_corsa === 'condivisa') {
            const esistenti = c.fermate_pianificate?.nodi || [];
            const maxFermate = c.max_fermate_consentite || 5;

            const salitaVicina = esistenti.find(f => f.coord && turf.distance(startSnap.geometry.coordinates, f.coord) < MIN_DIST_FUSIONE);
            if (salitaVicina) {
                startSnap.properties.index = salitaVicina.index;
                isFusione = true;
            } else if (esistenti.length >= maxFermate) return;

            const discesaVicina = esistenti.find(f => f.coord && turf.distance(endSnap.geometry.coordinates, f.coord) < MIN_DIST_FUSIONE);
            if (discesaVicina) {
                endSnap.properties.index = discesaVicina.index;
                isFusione = true;
            } else if (esistenti.length + (salitaVicina ? 0 : 1) >= maxFermate) return;
        }

        const startIdx = startSnap.properties.index;
        const endIdx = endSnap.properties.index;
        
        // La destinazione deve sempre essere dopo la salita
        if (endIdx <= startIdx) return;

        // VALIDAZIONE ATOMICA IN MEMORIA
        const prenotazioniCorsa = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
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
 * Utilizza riduzione sicura per calcolare l'occupazione totale per segmento.
 */
function verificaDisponibilitaInMemoria(corsa, startIdx, endIdx, postiRichiesti, prenotazioni) {
    const postiTotali = Number(corsa.posti_totali || 0);
    
    for (let i = startIdx; i < endIdx; i++) {
        const occupazioneSegmento = prenotazioni.reduce((acc, p) => {
            // Assicuriamo che le proprietà delle prenotazioni siano numeriche
            const pStart = Number(p.startIdx);
            const pEnd = Number(p.endIdx);
            const pPosti = Number(p.posti_richiesti);
            
            if (pStart <= i && pEnd > i) return acc + pPosti;
            return acc;
        }, 0);

        if ((occupazioneSegmento + Number(postiRichiesti)) > postiTotali) return false;
    }
    return true;
}

/**
 * Filtra gli slot disponibili (veicoli liberi)
 */
export function filterSlotOnly(richiesta, slots) {
    if (!slots || !Array.isArray(slots)) return [];
    
    return slots.filter(s => 
        s.disponibile === true && 
        Number(s.posti_totali || 0) >= Number(richiesta.posti_richiesti || 0)
    );
}