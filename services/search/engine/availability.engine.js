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
 * Motore di ricerca ottimizzato con Logica di Fusione Fermate e Pre-filtro
 */
export async function filterDisponibilita(db, richiesta, corseCandidate) {
    const corseValide = [];
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    // Costanti di tuning (aumenta MIN_DIST_FUSIONE se vuoi fermate più "agglomerate")
    const TOLLERANZA_KM = 0.5; 
    const MIN_DIST_FUSIONE = 0.4; 

    for (const c of corseCandidate) {
        if (!c.decodedCoords || c.decodedCoords.length < 2) continue;

        const route = turf.lineString(c.decodedCoords);
        let startSnap = getSnapResult(route, pStart, TOLLERANZA_KM, c);
        let endSnap = getSnapResult(route, pEnd, TOLLERANZA_KM, c);

        if (!startSnap || !endSnap) continue;

        let isFusione = false;
        
        // Logica Condivisa: Fusione o Validazione
        if (c.tipo_corsa === 'condivisa') {
            const esistenti = c.fermate_pianificate?.nodi || [];
            const maxFermate = c.max_fermate_consentite || 5;

            // Tentativo Fusione Salita
            const salitaVicina = esistenti.find(f => turf.distance(startSnap.geometry.coordinates, f.coord) < MIN_DIST_FUSIONE);
            if (salitaVicina) {
                startSnap.properties.index = salitaVicina.index;
                isFusione = true;
            } else if (esistenti.length >= maxFermate) {
                continue; 
            }

            // Tentativo Fusione Discesa
            const discesaVicina = esistenti.find(f => turf.distance(endSnap.geometry.coordinates, f.coord) < MIN_DIST_FUSIONE);
            if (discesaVicina) {
                endSnap.properties.index = discesaVicina.index;
                isFusione = true;
            } else if (esistenti.length + (salitaVicina ? 0 : 1) >= maxFermate) {
                continue; 
            }
        }

        const startIdx = startSnap.properties.index;
        const endIdx = endSnap.properties.index;
        
        // Validazione sequenza (la discesa deve essere successiva alla salita)
        if (endIdx <= startIdx) continue;

        // Verifica capacità atomica
        // NOTA: Per alta scala, qui dovresti chiamare una funzione batch invece di una query singola
        const { rows } = await db.query(
            "SELECT verifica_disponibilita($1, $2, $3, $4) as disponibile", 
            [c.id, startIdx, endIdx, richiesta.posti_richiesti]
        );

        if (rows[0]?.disponibile) {
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
    }
    return corseValide;
}