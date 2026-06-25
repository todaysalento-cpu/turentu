import * as turf from '@turf/turf';
import polyline from '@mapbox/polyline';
import { pool } from '../../db/db.js';

/**
 * Helper per determinare la classe in base all'indice (pre-calcolato nel DB)
 */
function determinaClasse(indice) {
    if (indice <= 0.3) return 'SAVER';
    if (indice <= 1.5) return 'STANDARD';
    return 'EXPRESS';
}

/**
 * Logica di Snap Polimorfica
 */
function getSnapResult(point, corsa, tolleranzaKm) {
    const isAnchor = corsa.tipo_corsa === 'condivisa';

    if (isAnchor) {
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
            } catch (e) { console.error(`⚠️ [SNAP] Errore polyline:`, e); }
        }
        return null;
    }

    const nodi = corsa.nodi_sequenza || [];
    let nearest = null;
    let min = tolleranzaKm;

    for (const n of nodi) {
        const pNodo = turf.point([n.lon, n.lat]);
        const d = turf.distance(point, pNodo, { units: 'kilometers' });
        if (d < min) {
            min = d;
            nearest = { ...n, type: 'STATIC', dist: d };
        }
    }
    return nearest;
}

/**
 * Motore di filtraggio aggiornato
 * - Arricchisce la corsa con la classe di efficienza
 * - Usa la capacità reale del veicolo per la saturazione
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch) {
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 2.0;

    return {
        corse: await Promise.all(corseCandidate.map(async (c, index) => {
            // 1. Arricchimento: assegnazione classe basata su indice DB
            c.classe = determinaClasse(Number(c.indice_efficienza || 0));
            
            const startSnap = getSnapResult(pStart, c, TOLLERANZA_KM);
            const endSnap = getSnapResult(pEnd, c, TOLLERANZA_KM);

            if (!startSnap || !endSnap) return null;

            // 2. LOGICA CONDIVISA
            if (c.tipo_corsa === 'condivisa') {
                const startOffset = Number(startSnap.offset_metri);
                const endOffset = Number(endSnap.offset_metri);
                if (startOffset >= endOffset || (endOffset - startOffset) < 2000) return null;
                
                c.startOffset = startOffset;
                c.endOffset = endOffset;
                const prenotazioni = Array.isArray(prenotazioniBatch[index]) ? prenotazioniBatch[index] : [];
                return verificaSaturazioneOffset(c, startOffset, endOffset, Number(richiesta.posti_richiesti), prenotazioni) ? c : null;
            }

            // 3. LOGICA POP-BUS / RITORNO
            if (startSnap.ordine_sequenziale >= endSnap.ordine_sequenziale) return null;

            const isSaturato = await verificaSaturazioneSegmenti(
                c.direttrice_id || c.id, 
                startSnap.ordine_sequenziale, 
                endSnap.ordine_sequenziale, 
                Number(richiesta.posti_richiesti),
                Number(c.posti_totali) // Capacità dinamica dal DB
            );

            return isSaturato ? null : c;
        })).then(results => results.filter(c => c !== null))
    };
}

/**
 * Controllo saturazione dinamico basato sulla capacità reale del veicolo
 */
async function verificaSaturazioneSegmenti(direttrice_id, seqStart, seqEnd, postiRichiesti, capacitaTotale) {
    const { rows } = await pool.query(`
        SELECT SUM(posti_occupati) as occupati
        FROM segmenti
        WHERE direttrice_id = $1 
        AND ordine_sequenziale >= $2 
        AND ordine_sequenziale <= $3
    `, [direttrice_id, seqStart, seqEnd]);

    const occupati = Number(rows[0]?.totale_carico || 0);
    return (occupati + postiRichiesti) > capacitaTotale; 
}

function verificaSaturazioneOffset(corsa, startO, endO, postiRichiesti, prenotazioni) {
    const postiTotali = Number(corsa.posti_totali || 0);
    const postiGiaPrenotati = Number(corsa.posti_prenotati || 0);
    for (const p of prenotazioni) {
        if (startO < Number(p.endOffset) && endO > Number(p.startOffset)) {
            if ((Number(p.posti_richiesti) + postiRichiesti + postiGiaPrenotati) > postiTotali) return false;
        }
    }
    return true;
}