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
        if (nearestNode) {
            console.log(`📍 [SNAP] Trovato nodo STATIC (id: ${nearestNode.id}) a ${nearestNode.dist.toFixed(2)}km`);
            return nearestNode;
        }
    }

    // 2. FALLBACK DINAMICO (Punto virtuale su Polyline)
    if (corsa.polyline) {
        const line = turf.lineString(corsa.polyline);
        const snapped = turf.nearestPointOnLine(line, point, { units: 'kilometers' });
        
        if (snapped.properties.dist < tolleranzaKm) {
            console.log(`🌐 [SNAP] Creato punto DYNAMIC (offset: ${snapped.properties.location * 1000}m) a ${snapped.properties.dist.toFixed(2)}km dalla linea.`);
            return {
                id: null,
                offset_metri: snapped.properties.location * 1000,
                type: 'DYNAMIC',
                dist: snapped.properties.dist
            };
        }
    }

    console.log(`❌ [SNAP] Nessun aggancio possibile entro ${tolleranzaKm}km.`);
    return null;
}

/**
 * Motore di validazione ibrido (Statico + Dinamico) con log di debug
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    console.log(`🔍 [ENGINE] Inizio filtraggio ibrido. Richiesta: [${richiesta.coord?.lat}, ${richiesta.coord?.lon}] -> [${richiesta.coordDest?.lat}, ${richiesta.coordDest?.lon}]`);

    if (!richiesta.coord || !richiesta.coordDest) return { corse: [] };

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 2.0; 
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    const corseValide = corseCandidate.filter((c, index) => {
        if (c.tipo_corsa === 'pop-bus') return false;
        
        console.log(`⚙️ [CORSA ${c.id}] Analisi disponibilità...`);

        // 1. Snap ibrido
        const startSnap = getSnapResult(pStart, c, TOLLERANZA_KM);
        const endSnap = getSnapResult(pEnd, c, TOLLERANZA_KM);

        if (!startSnap || !endSnap) {
            console.log(`❌ [CORSA ${c.id}] Scartata: Geofencing fallito.`);
            return false;
        }

        // 2. Calcolo Offset
        const startOffset = Number(startSnap.offset_metri);
        const endOffset = Number(endSnap.offset_metri);
        
        console.log(`📏 [CORSA ${c.id}] Segmento calcolato: ${startOffset.toFixed(0)}m -> ${endOffset.toFixed(0)}m`);

        if (startOffset >= endOffset) {
            console.log(`❌ [CORSA ${c.id}] Scartata: Direzione non coerente.`);
            return false;
        }

        c.distanza = Math.abs(endOffset - startOffset);
        
        // 3. Verifica Saturazione
        const prenotazioni = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
        const isDisponibile = verificaSaturazioneOffset(c, startOffset, endOffset, postiRichiesti, prenotazioni);
        
        if (isDisponibile) {
            console.log(`✅ [CORSA ${c.id}] IDONEA | Posti: ${c.posti_totali}`);
            return true;
        }
        return false;
    });

    console.log(`📡 [ENGINE] Filtro completato. Valide: ${corseValide.length}`);
    return { corse: corseValide };
}

function verificaSaturazioneOffset(corsa, startO, endO, postiRichiesti, prenotazioni) {
    const postiTotali = Number(corsa.posti_totali || 8);
    
    for (const p of prenotazioni) {
        const pStart = Number(p.startOffset);
        const pEnd = Number(p.endOffset);
        
        if (startO < pEnd && endO > pStart) {
            const occupazione = Number(p.posti_richiesti);
            if ((occupazione + postiRichiesti) > postiTotali) {
                console.log(`🔍 [DEBUG SATURAZIONE] Corsa ${corsa.id} satura: richiesta ${postiRichiesti} su ${occupazione} esistenti.`);
                return false;
            }
        }
    }
    return true;
}