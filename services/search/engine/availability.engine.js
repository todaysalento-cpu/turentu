import * as turf from '@turf/turf';

/**
 * Helper per snap su linea o nodi specifici con log di debug
 */
function getSnapResult(route, point, tolleranzaKm, corsa) {
    // Gestione nodi per corse dinamiche
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
        if (!nearestNode) console.log(`   ⚠️ [SNAP] Nessun nodo vicino per corsa ${corsa.id} (Tolleranza: ${tolleranzaKm}km)`);
        return nearestNode;
    }
    
    // Gestione standard su polilinea
    if (!route) return null;
    const nearest = turf.nearestPointOnLine(route, point);
    const dist = turf.distance(point, nearest, { units: 'kilometers' });
    
    if (dist <= tolleranzaKm) {
        return { ...nearest, properties: { ...nearest.properties, index: nearest.properties.index ?? 0 } };
    } else {
        console.log(`   ⚠️ [SNAP] Punto troppo lontano per corsa ${corsa.id}: Distanza ${dist.toFixed(2)}km`);
    }
    return null;
}

/**
 * Motore di ricerca: focalizzato sulle corse classiche
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    if (!richiesta.coord || !richiesta.coordDest) return { corse: [] };

    console.log(`🔍 [ENGINE] Inizio analisi su ${corseCandidate.length} corse candidate.`);

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    const TOLLERANZA_KM = 2.0; // Aumentata temporaneamente per testare la geometria
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    const corseValide = corseCandidate.filter((c, index) => {
        if (c.tipo_corsa === 'pop-bus') return false;
        if (!c.decodedCoords || c.decodedCoords.length < 2) {
            console.log(`   ❌ [CORSA ${c.id}] Scartata: decodedCoords mancanti o insufficienti.`);
            return false;
        }

        const route = turf.lineString(c.decodedCoords);
        const startSnap = getSnapResult(route, pStart, TOLLERANZA_KM, c);
        const endSnap = getSnapResult(route, pEnd, TOLLERANZA_KM, c);

        if (!startSnap?.properties || !endSnap?.properties) {
            console.log(`   ❌ [CORSA ${c.id}] Scartata: Snap fallito (Start: ${!!startSnap}, End: ${!!endSnap})`);
            return false;
        }

        const startIdx = Number(startSnap.properties.index);
        const endIdx = Number(endSnap.properties.index);
        console.log(`   ✅ [CORSA ${c.id}] Snap OK: Indici ${startIdx} -> ${endIdx}`);
        
        const prenotazioni = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
        const isDisponibile = verificaDisponibilitaInMemoria(c, startIdx, endIdx, postiRichiesti, prenotazioni);

        console.log(`   🏁 [CORSA ${c.id}] Verifica Saturazione: ${isDisponibile ? 'OK (Disponibile)' : 'SATURA'}`);
        return isDisponibile;
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
        if ((occupazioneSegmento + postiRichiesti) > postiTotali) {
            console.log(`      ⛔ [SATURAZIONE] Segmento ${i} saturo: ${occupazioneSegmento + postiRichiesti}/${postiTotali}`);
            return false;
        }
    }
    return true;
}