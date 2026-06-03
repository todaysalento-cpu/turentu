import * as turf from '@turf/turf';

/**
 * Helper per snap su linea o nodi specifici
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
        return nearestNode;
    }
    
    // Gestione standard su polilinea
    if (!route) return null;
    const nearest = turf.nearestPointOnLine(route, point);
    const dist = turf.distance(point, nearest, { units: 'kilometers' });
    if (dist <= tolleranzaKm) {
        return { ...nearest, properties: { ...nearest.properties, index: nearest.properties.index ?? 0 } };
    }
    return null;
}

/**
 * Motore di ricerca aggiornato: gestisce separatamente corse e pool
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch, poolVeicoliDisponibili = []) {
    if (!richiesta.coord || !richiesta.coordDest) return { corse: [], poolDisponibile: false };

    console.log(`🔍 [ENGINE] Analisi | Corse candidate: ${corseCandidate.length} | Pool veicoli: ${poolVeicoliDisponibili.length}`);

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    const TOLLERANZA_KM = 0.5; 
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    // 1. Filtro Corse Classiche (Atomiche)
    const corseValide = corseCandidate.filter((c, index) => {
        // Ignoriamo i 'pop-bus' qui, verranno gestiti come offerta di pool
        if (c.tipo_corsa === 'pop-bus') return false;
        if (!c.decodedCoords || c.decodedCoords.length < 2) return false;

        const route = turf.lineString(c.decodedCoords);
        const startSnap = getSnapResult(route, pStart, TOLLERANZA_KM, c);
        const endSnap = getSnapResult(route, pEnd, TOLLERANZA_KM, c);

        if (!startSnap?.properties || !endSnap?.properties) return false;

        const startIdx = Number(startSnap.properties.index);
        const endIdx = Number(endSnap.properties.index);
        
        const prenotazioni = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
        const isDisponibile = verificaDisponibilitaInMemoria(c, startIdx, endIdx, postiRichiesti, prenotazioni);

        console.log(`🚗 [CORSA ${c.id}] Verifica: ${isDisponibile ? 'OK' : 'SATURA'}`);
        return isDisponibile;
    });

    // 2. Verifica disponibilità Pool Aggregato
    const isPoolDisponibile = richiesta.tipo_richiesto === 'pop-bus' && 
                              verificaDisponibilitaPool(poolVeicoliDisponibili, postiRichiesti);

    return { 
        corse: corseValide, 
        poolDisponibile: isPoolDisponibile 
    };
}

/**
 * Logica calcolo disponibilità su Pool Aggregato
 */
function verificaDisponibilitaPool(poolVeicoli, postiRichiesti) {
    const capacitaTotalePool = poolVeicoli.reduce((sum, v) => sum + Number(v.posti_totali || 0), 0);
    console.log(`📊 [POOL-STATS] Capacità totale rilevata: ${capacitaTotalePool} posti.`);
    return capacitaTotalePool >= postiRichiesti;
}

/**
 * Verifica saturazione segmentata per corse classiche
 */
function verificaDisponibilitaInMemoria(corsa, startIdx, endIdx, postiRichiesti, prenotazioni) {
    const postiTotali = Number(corsa.posti_totali || 0);
    // Garantiamo startIdx < endIdx
    const s = Math.min(startIdx, endIdx);
    const e = Math.max(startIdx, endIdx);

    for (let i = s; i < e; i++) {
        let occupazioneSegmento = 0;
        for (const p of prenotazioni) {
            // Verifica sovrapposizione segmenti
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