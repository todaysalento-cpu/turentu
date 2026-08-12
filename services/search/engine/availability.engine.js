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
 * SNAP LOGIC CON LOG AGGIUNTIVI E CORREZIONE COORDINATE POLYLINE
 */
function getSnapResult(point, corsa, tolleranzaKm, corsaId) {
    const isAnchor = corsa.tipo_corsa === 'condivisa';

    if (isAnchor) {
        if (corsa.percorso_polyline) {
            try {
                const decoded = polyline.decode(corsa.percorso_polyline);
                
                // NOTA: Mapbox polyline decodifica in [lat, lon]. Turf.js si aspetta [lon, lat] -> [c[1], c[0]]
                const coordinates = decoded.map(c => [c[1], c[0]]);
                
                const line = turf.lineString(coordinates);
                const snapped = turf.nearestPointOnLine(line, point, { units: 'kilometers' });

                if (snapped.properties.dist < tolleranzaKm) {
                    return {
                        offset_metri: snapped.properties.location * turf.length(line, { units: 'meters' }),
                        type: 'DYNAMIC',
                        dist: snapped.properties.dist
                    };
                } else {
                    console.log(`⚠️ [SNAP FALLITO] Corsa ${corsaId}: Distanza dal percorso di ${snapped.properties.dist.toFixed(2)} km superiore alla tolleranza (${tolleranzaKm} km)`);
                }
            } catch (e) {
                console.error(`⚠️ [SNAP ERROR] Corsa ${corsaId}:`, e);
            }
        } else {
            console.log(`⚠️ [SNAP FALLITO] Corsa ${corsaId}: percorso_polyline mancante.`);
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
    if (!nearest) {
        console.log(`⚠️ [SNAP STATIC FALLITO] Corsa ${corsaId}: nessun nodo entro ${tolleranzaKm} km.`);
    }
    return nearest;
}

/**
 * MAIN ENGINE - FULLY INTEGRATED (UNIVERSAL MODE)
 */
export async function filterDisponibilita(richiesta, corseCandidate, prenotazioniBatch, capacitaMap = new Map()) {
    // Corretto ordine a [lon, lat] per coerenza con Turf e polyline
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 50.0;

    return {
        corse: (await Promise.all(corseCandidate.map(async (c, index) => {
            if (!c) return null;
            c.classe = determinaClasse(Number(c.indice_efficienza || 0));

            const idString = typeof c.id === 'string' ? c.id : String(c.id || '');
            const isProattivo = idString.startsWith('virtual_pop_');
            
            const startSnap = !isProattivo ? getSnapResult(pStart, c, TOLLERANZA_KM, c.id) : { ordine_sequenziale: 0 };
            const endSnap = !isProattivo ? getSnapResult(pEnd, c, TOLLERANZA_KM, c.id) : { ordine_sequenziale: 999 };

            if (!isProattivo && (!startSnap || !endSnap)) {
                console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id}: scartata perché startSnap o endSnap sono nulli.`);
                return null;
            }

            // --- LOGICA CONDIVISA ---
            if (c.tipo_corsa === 'condivisa') {
                const startOffset = Number(startSnap.offset_metri);
                const endOffset = Number(endSnap.offset_metri);
                
                if (startOffset >= endOffset || (endOffset - startOffset) < 2000) {
                    console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id}: offset non validi (startOffset: ${startOffset}, endOffset: ${endOffset}, differenza: ${endOffset - startOffset} metri).`);
                    return null;
                }

                const prenotazioni = Array.isArray(prenotazioniBatch?.[index]) ? prenotazioniBatch[index] : [];
                const capacitaTotale = capacitaMap.get(c.id) ?? Number(c.posti_totali || 0);

                const isSaturata = verificaSaturazioneOffset(c, startOffset, endOffset, Number(richiesta.posti_richiesti), prenotazioni, capacitaTotale);
                if (!isSaturata) {
                    console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id}: scartata per saturazione posti nel tratto.`);
                    return null;
                }

                console.log(`✅ [SUCCESSO FILTER] Corsa ID ${c.id} superata con successo!`);
                return c;
            }

            // --- LOGICA POP-BUS (Universale) ---
            const baseResult = { ...c, veicoli_pool_ids: c.veicoli_pool_ids || [] };

            if (c.direttrice_id) {
                if (startSnap.ordine_sequenziale >= endSnap.ordine_sequenziale) {
                    console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id} (Pop-Bus): ordine sequenziale non valido.`);
                    return null;
                }
                
                const capacitaTotale = capacitaMap.get(c.direttrice_id) ?? Number(c.posti_totali || 0);
                
                const isAndataSaturata = await verificaSaturazioneSegmenti(
                    c.direttrice_id, 
                    startSnap.ordine_sequenziale, 
                    endSnap.ordine_sequenziale, 
                    Number(richiesta.posti_richiesti), 
                    capacitaTotale
                );
                if (isAndataSaturata) {
                    console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id} (Pop-Bus): andata saturata.`);
                    return null;
                }

                if (richiesta.return_datetime || richiesta.include_ritorno) {
                    const isRitornoSaturato = await verificaSaturazioneRitorno(
                        c.direttrice_id,
                        Number(richiesta.posti_richiesti),
                        capacitaTotale
                    );
                    if (isRitornoSaturato) {
                        console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id} (Pop-Bus): ritorno saturato.`);
                        return null;
                    }
                }

                console.log(`✅ [SUCCESSO FILTER] Corsa ID ${c.id} (Pop-Bus) superata con successo!`);
                return baseResult;
            }

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
        const pStart = Number(p.start_index_polyline ?? p.startOffset ?? 0);
        const pEnd = Number(p.end_index_polyline ?? p.endOffset ?? 0);

        if (startO < pEnd && endO > pStart) {
            postiOccupatiNelTratto += Number(p.posti_richiesti || 0);
        }
    }

    return (postiOccupatiNelTratto + postiRichiesti) <= postiTotali;
}