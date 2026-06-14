import * as turf from '@turf/turf';

/**
 * Snap Ibrido: Cerca prima nelle fermate pianificate, poi proietta sulla polyline.
 * Adattato per lo schema "public.corse" (JSONB e TEXT).
 */
function getSnapResult(point, corsa, tolleranzaKm) {
    // 1. TENTATIVO STATICO: Usa le fermate pianificate (JSONB)
    const fermate = Array.isArray(corsa.fermate_pianificate) ? corsa.fermate_pianificate : [];
    
    if (fermate.length > 0) {
        let nearest = null;
        let min = tolleranzaKm;
        for (const f of fermate) {
            // Assicuriamo che la fermata abbia coordinate (lon, lat)
            const pFermata = turf.point([f.lon, f.lat]);
            const d = turf.distance(point, pFermata, { units: 'kilometers' });
            if (d < min) { 
                min = d; 
                // Recupera l'offset dalla fermata o default a 0
                nearest = { ...f, offset_metri: f.offset_metri || 0, type: 'STATIC', dist: d }; 
            }
        }
        if (nearest) {
            console.log(`📍 [SNAP] Trovato nodo STATIC (id: ${nearest.id || 'N/A'}) a ${nearest.dist.toFixed(2)}km`);
            return nearest;
        }
    }

    // 2. FALLBACK DINAMICO: Usa la polyline memorizzata nella corsa
    if (corsa.percorso_polyline) {
        try {
            // Assumiamo che percorso_polyline sia un formato compatibile con lineString (Array di [lon, lat])
            const line = turf.lineString(corsa.percorso_polyline); 
            const snapped = turf.nearestPointOnLine(line, point, { units: 'kilometers' });
            
            if (snapped.properties.dist < tolleranzaKm) {
                console.log(`🌐 [SNAP] Creato punto DYNAMIC (offset: ${snapped.properties.location * 1000}m) a ${snapped.properties.dist.toFixed(2)}km.`);
                return {
                    offset_metri: snapped.properties.location * 1000,
                    type: 'DYNAMIC',
                    dist: snapped.properties.dist
                };
            }
        } catch (e) {
            console.error(`⚠️ [SNAP] Errore polyline per corsa ${corsa.id}:`, e);
        }
    }

    console.log(`❌ [SNAP] Nessun aggancio possibile entro ${tolleranzaKm}km.`);
    return null;
}

/**
 * Motore di validazione ibrido (Statico + Dinamico)
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    console.log(`🔍 [ENGINE] Inizio filtraggio su ${corseCandidate.length} corse.`);

    if (!richiesta.coord || !richiesta.coordDest) return { corse: [] };

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 2.0; 
    const postiRichiesti = Number(richiesta.posti_richiesti || 1);

    const corseValide = corseCandidate.filter((c, index) => {
        // Nota: se vuoi includere anche i pop-bus nel calcolo, rimuovi il filtro seguente
        if (c.tipo_corsa === 'pop-bus') return false;
        
        console.log(`⚙️ [CORSA ${c.id}] Analisi disponibilità...`);

        const startSnap = getSnapResult(pStart, c, TOLLERANZA_KM);
        const endSnap = getSnapResult(pEnd, c, TOLLERANZA_KM);

        if (!startSnap || !endSnap) {
            console.log(`❌ [CORSA ${c.id}] Scartata: Geofencing fallito.`);
            return false;
        }

        const startOffset = Number(startSnap.offset_metri);
        const endOffset = Number(endSnap.offset_metri);
        
        console.log(`📏 [CORSA ${c.id}] Segmento: ${startOffset.toFixed(0)}m -> ${endOffset.toFixed(0)}m`);

        if (startOffset >= endOffset) {
            console.log(`❌ [CORSA ${c.id}] Scartata: Direzione non coerente.`);
            return false;
        }

        c.startOffset = startOffset; // Salvato per il formattatore
        c.endOffset = endOffset;
        c.distanza = Math.abs(endOffset - startOffset);
        
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
                console.log(`🔍 [DEBUG SATURAZIONE] Corsa ${corsa.id} satura.`);
                return false;
            }
        }
    }
    return true;
}