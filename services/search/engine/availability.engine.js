import * as turf from '@turf/turf';
import polyline from '@mapbox/polyline';

/**
 * Logica di Snap Polimorfica:
 * - 'condivisa': Rigore geometrico (proiezione su polyline).
 * - 'pop-bus' / 'riempimento': Flessibilità (fermate statiche + fallback dinamico).
 */
function getSnapResult(point, corsa, tolleranzaKm) {
    const isAnchor = corsa.tipo_corsa === 'condivisa';

    // 1. TENTATIVO STATICO (Solo per Pop-Bus/Riempimento)
    if (!isAnchor) {
        const fermate = Array.isArray(corsa.fermate_pianificate) ? corsa.fermate_pianificate : [];
        if (fermate.length > 0) {
            let nearest = null;
            let min = tolleranzaKm;
            for (const f of fermate) {
                const pFermata = turf.point([f.lon, f.lat]);
                const d = turf.distance(point, pFermata, { units: 'kilometers' });
                if (d < min) { 
                    min = d; 
                    nearest = { ...f, offset_metri: f.offset_metri || 0, type: 'STATIC', dist: d }; 
                }
            }
            if (nearest) return nearest;
        }
    }

    // 2. FALLBACK/CORE DINAMICO (Proiezione Polyline)
    if (corsa.percorso_polyline && typeof corsa.percorso_polyline === 'string') {
        try {
            const decoded = polyline.decode(corsa.percorso_polyline);
            const coordinates = decoded.map(c => [c[1], c[0]]);
            const line = turf.lineString(coordinates); 
            const snapped = turf.nearestPointOnLine(line, point, { units: 'kilometers' });
            
            if (snapped.properties.dist < tolleranzaKm) {
                return {
                    offset_metri: snapped.properties.location * turf.length(line, { units: 'meters' }),
                    type: 'DYNAMIC',
                    dist: snapped.properties.dist
                };
            }
        } catch (e) {
            console.error(`⚠️ [SNAP] Errore polyline corsa ${corsa.id}:`, e);
        }
    }
    return null;
}

/**
 * Motore di filtraggio allineato alla tabella 'corse'
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    
    // Costanti di business
    const TOLLERANZA_KM = 2.0;
    const DISTANZA_MINIMA_ANCHOR = 2000; // 2km minimi per corse condivise (Anchor)

    return {
        corse: corseCandidate.filter((c, index) => {
            // Analisi basata sul tipo_corsa della tabella
            const startSnap = getSnapResult(pStart, c, TOLLERANZA_KM);
            const endSnap = getSnapResult(pEnd, c, TOLLERANZA_KM);

            if (!startSnap || !endSnap) return false;

            const startOffset = Number(startSnap.offset_metri);
            const endOffset = Number(endSnap.offset_metri);

            // Vincoli di direzione
            if (startOffset >= endOffset) return false;

            // Vincolo anti-frammentazione per corse di tipo 'condivisa' (Anchor)
            if (c.tipo_corsa === 'condivisa' && (endOffset - startOffset) < DISTANZA_MINIMA_ANCHOR) {
                return false;
            }

            c.startOffset = startOffset;
            c.endOffset = endOffset;
            c.distanza = Math.abs(endOffset - startOffset);
            
            const prenotazioni = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
            return verificaSaturazioneOffset(c, startOffset, endOffset, Number(richiesta.posti_richiesti), prenotazioni);
        })
    };
}

function verificaSaturazioneOffset(corsa, startO, endO, postiRichiesti, prenotazioni) {
    // Utilizza le colonne reali 'posti_totali' e 'posti_prenotati' della tabella
    const postiTotali = Number(corsa.posti_totali || 0);
    const postiGiaPrenotati = Number(corsa.posti_prenotati || 0);
    
    // Controllo saturazione dinamica basato sui segmenti
    for (const p of prenotazioni) {
        if (startO < Number(p.endOffset) && endO > Number(p.startOffset)) {
            if ((Number(p.posti_richiesti) + postiRichiesti + postiGiaPrenotati) > postiTotali) {
                return false;
            }
        }
    }
    return true;
}