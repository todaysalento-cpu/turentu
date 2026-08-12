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
 * MAIN ENGINE - FULLY INTEGRATED (UNIVERSAL MODE)
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch, capacitaMap = new Map()) {
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 2.0;

    return {
        corse: (await Promise.all(corseCandidate.map(async (c, index) => {
            if (!c) return null;
            c.classe = determinaClasse(Number(c.indice_efficienza || 0));

            // PROTEZIONE TOTALE: normalizzazione sicura dell'id per evitare TypeError
            const idString = typeof c.id === 'string' ? c.id : String(c.id || '');
            const isProattivo = idString.startsWith('virtual_pop_');
            
            const startSnap = !isProattivo ? getSnapResult(pStart, c, TOLLERANZA_KM) : { ordine_sequenziale: 0 };
            const endSnap = !isProattivo ? getSnapResult(pEnd, c, TOLLERANZA_KM) : { ordine_sequenziale: 999 };

            if (!isProattivo && (!startSnap || !endSnap)) return null;

            // --- LOGICA CONDIVISA ---
            if (c.tipo_corsa === 'condivisa') {
                const startOffset = Number(startSnap.offset_metri);
                const endOffset = Number(endSnap.offset_metri);
                if (startOffset >= endOffset || (endOffset - startOffset) < 2000) return null;

                const prenotazioni = Array.isArray(prenotazioniBatch?.[index]) ? prenotazioniBatch[index] : [];
                const capacitaTotale = capacitaMap.get(c.id) ?? Number(c.posti_totali || 0);

                return verificaSaturazioneOffset(c, startOffset, endOffset, Number(richiesta.posti_richiesti), prenotazioni, capacitaTotale) ? c : null;
            }

            // --- LOGICA POP-BUS (Universale) ---
            const baseResult = { ...c, veicoli_pool_ids: c.veicoli_pool_ids || [] };

            if (c.direttrice_id) {
                if (startSnap.ordine_sequenziale >= endSnap.ordine_sequenziale) return null;
                
                const capacitaTotale = capacitaMap.get(c.direttrice_id) ?? Number(c.posti_totali || 0);
                
                // 1. Verifica saturazione sull'andata (segmenti)
                const isAndataSaturata = await verificaSaturazioneSegmenti(
                    c.direttrice_id, 
                    startSnap.ordine_sequenziale, 
                    endSnap.ordine_sequenziale, 
                    Number(richiesta.posti_richiesti), 
                    capacitaTotale
                );
                if (isAndataSaturata) return null;

                // 2. Se la richiesta prevede un ritorno, verifica la saturazione anche sulla missione/segmento di ritorno
                if (richiesta.return_datetime || richiesta.include_ritorno) {
                    const isRitornoSaturato = await verificaSaturazioneRitorno(
                        c.direttrice_id,
                        Number(richiesta.posti_richiesti),
                        capacitaTotale
                    );
                    if (isRitornoSaturato) return null;
                }

                return baseResult;
            }

            // Se arriviamo qui, è una risorsa proattiva valida per il Pricing
            return { ...baseResult, is_proattivo: true };
        }))).filter(Boolean)
    };
}

/**
 * SATURAZIONE SEGMENTI (ANDATA)
 */
async function verificaSaturazioneSegmenti(direttrice_id, seqStart, seqEnd, postiRichiesti, capacitaTotale) {
    const { rows } = await pool.query(
        `SELECT COALESCE(SUM(posti_occupati), 0) as occupati
         FROM segmenti
         WHERE direttrice_id = $1
         AND ordine_sequenziale BETWEEN $2 AND $3`,
        [direttrice_id, seqStart, seqEnd]
    );
    return Number(rows[0]?.occupati || 0) + postiRichiesti > capacitaTotale;
}

/**
 * SATURAZIONE MISSIONE DI RITORNO
 */
async function verificaSaturazioneRitorno(direttrice_id, postiRichiesti, capacitaTotale) {
    const { rows } = await pool.query(
        `SELECT COALESCE(SUM(s.posti_occupati), 0) as occupati_ritorno
         FROM missioni_ritorno mr
         JOIN segmenti s ON mr.segmento_id = s.id
         WHERE s.direttrice_id = $1`,
        [direttrice_id]
    );
    return Number(rows[0]?.occupati_ritorno || 0) + postiRichiesti > capacitaTotale;
}

/**
 * SATURAZIONE OFFSET
 */
function verificaSaturazioneOffset(corsa, startO, endO, postiRichiesti, prenotazioni, capacitaTotale) {
    const postiTotali = capacitaTotale ?? Number(corsa.posti_totali || 0);
    let postiOccupatiNelTratto = 0;

    for (const p of prenotazioni) {
        // Gestione compatibile sia con start_index_polyline (DB) che con startOffset (eventuale cache)
        const pStart = Number(p.start_index_polyline ?? p.startOffset ?? 0);
        const pEnd = Number(p.end_index_polyline ?? p.endOffset ?? 0);

        // Se l'intervallo della prenotazione esistente si sovrappone al nostro tragitto
        if (startO < pEnd && endO > pStart) {
            postiOccupatiNelTratto += Number(p.posti_richiesti || 0);
        }
    }

    // Restituisce true se i posti occupati nel tratto + quelli richiesti rientrano nei posti totali
    return (postiOccupatiNelTratto + postiRichiesti) <= postiTotali;
}