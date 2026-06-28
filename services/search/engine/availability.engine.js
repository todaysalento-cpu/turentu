import * as turf from '@turf/turf';
import polyline from '@mapbox/polyline';
import { pool } from '../../../db/db.js';

/**
 * Classe efficienza
 */
function determinaClasse(indice) {
    if (indice <= 0.3) return 'SAVER';
    if (indice <= 1.5) return 'STANDARD';
    return 'EXPRESS';
}

/**
 * SNAP LOGIC
 */
function getSnapResult(point, corsa, tolleranzaKm) {
    const isAnchor = corsa.tipo_corsa === 'condivisa';

    if (isAnchor) {
        if (corsa.percorso_polyline) {
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
                console.error('⚠️ SNAP ERROR', e);
            }
        }
        return null;
    }

    const nodi = corsa.nodi_sequenza || [];
    let nearest = null;
    let min = tolleranzaKm;

    for (const n of nodi) {
        const d = turf.distance(point, turf.point([n.lon, n.lat]), { units: 'kilometers' });
        if (d < min) {
            min = d;
            nearest = { ...n, type: 'STATIC', dist: d };
        }
    }
    return nearest;
}

/**
 * MAIN ENGINE - AGGIORNATO PER POP-BUS PROATTIVO
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch, capacitaMap = new Map()) {
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 2.0;

    return {
        corse: (await Promise.all(corseCandidate.map(async (c, index) => {
            c.classe = determinaClasse(Number(c.indice_efficienza || 0));

            const startSnap = getSnapResult(pStart, c, TOLLERANZA_KM);
            const endSnap = getSnapResult(pEnd, c, TOLLERANZA_KM);

            if (!startSnap || !endSnap) return null;

            // --- LOGICA CONDIVISA ---
            if (c.tipo_corsa === 'condivisa') {
                const startOffset = Number(startSnap.offset_metri);
                const endOffset = Number(endSnap.offset_metri);

                if (startOffset >= endOffset || (endOffset - startOffset) < 2000) return null;

                const prenotazioni = Array.isArray(prenotazioniBatch?.[index]) ? prenotazioniBatch[index] : [];
                const capacitaTotale = capacitaMap.get(c.id) ?? Number(c.posti_totali || 0);

                return verificaSaturazioneOffset(c, startOffset, endOffset, Number(richiesta.posti_richiesti), prenotazioni, capacitaTotale) ? c : null;
            }

            // --- LOGICA POP-BUS (Ritorno e Proattivo) ---
            if (c.tipo === 'pop-bus' || c.tipo_corsa === 'pop-bus') {
                // Se ha una direttrice_id definita, effettuiamo il controllo di saturazione reale
                if (c.direttrice_id) {
                    if (startSnap.ordine_sequenziale >= endSnap.ordine_sequenziale) return null;

                    const id = c.direttrice_id;
                    const capacitaTotale = capacitaMap.get(id) ?? Number(c.posti_totali || 0);
                    const isSaturato = await verificaSaturazioneSegmenti(id, startSnap.ordine_sequenziale, endSnap.ordine_sequenziale, Number(richiesta.posti_richiesti), capacitaTotale);
                    
                    return isSaturato ? null : { ...c, veicoli_pool_ids: c.veicoli_pool_ids || [] };
                }

                // BYPASS PER POP-BUS PROATTIVO (Virtual)
                // Restituiamo l'oggetto arricchito per permettere al Pricing di calcolare lo stimato
                return {
                    ...c,
                    is_proattivo: true,
                    veicoli_pool_ids: c.veicoli_pool_ids || []
                };
            }

            return null;
        }))).filter(Boolean)
    };
}

/**
 * SATURAZIONE SEGMENTI (POOL OK)
 */
async function verificaSaturazioneSegmenti(direttrice_id, seqStart, seqEnd, postiRichiesti, capacitaTotale) {
    const { rows } = await pool.query(
        `SELECT COALESCE(SUM(posti_occupati), 0) as occupati
         FROM segmenti
         WHERE direttrice_id = $1
         AND ordine_sequenziale BETWEEN $2 AND $3`,
        [direttrice_id, seqStart, seqEnd]
    );
    const occupati = Number(rows[0]?.occupati || 0);
    return occupati + postiRichiesti > capacitaTotale;
}

/**
 * SATURAZIONE OFFSET
 */
function verificaSaturazioneOffset(corsa, startO, endO, postiRichiesti, prenotazioni, capacitaTotale) {
    const postiTotali = capacitaTotale ?? Number(corsa.posti_totali || 0);
    const postiGiaPrenotati = Number(corsa.posti_prenotati || 0);

    for (const p of prenotazioni) {
        if (startO < Number(p.endOffset) && endO > Number(p.startOffset)) {
            if (Number(p.posti_richiesti) + postiRichiesti + postiGiaPrenotati > postiTotali) {
                return false;
            }
        }
    }
    return true;
}