import * as turf from '@turf/turf';
import polyline from '@mapbox/polyline';
import { pool } from '../../../db/db.js';
import { CacheStore } from '../search.cache.js';
import { getDurataDistanza } from '../../../utils/maps.util.js';

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

                if (snapped.properties.dist <= tolleranzaKm) {
                    // Utilizziamo prioritariamente la colonna 'distanza' della corsa, convertita in metri,
                    // oppure fallback su km_totali_percorso o sulla lunghezza geometrica di Turf.
                    const kmTotaliCorsa = Number(corsa.distanza) || Number(corsa.km_totali_percorso) || 0;
                    const lunghezzaMetri = kmTotaliCorsa > 0 
                        ? kmTotaliCorsa * 1000 
                        : turf.length(line, { units: 'meters' });

                    return {
                        offset_metri: snapped.properties.location * lunghezzaMetri,
                        type: 'DYNAMIC',
                        dist: snapped.properties.dist
                    };
                } else {
                    console.log(`⚠️ [SNAP FALLITO] Corsa ${corsaId}: Distanza dal percorso di ${snapped.properties.dist.toFixed(2)} km superiore alla tolleranza (${tolleranzaKm} km)`);
                }
            } catch (e) {
                console.error(`⚠️️ [SNAP ERROR] Corsa ${corsaId}:`, e);
            }
        } else {
            console.log(`⚠️️ [SNAP FALLITO] Corsa ${corsaId}: percorso_polyline mancante.`);
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
    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 50.0;
    
    const isImmediata = (() => {
        const orarioAndataUtente = new Date(richiesta.start_datetime || new Date());
        const diffMinuti = (orarioAndataUtente.getTime() - new Date().getTime()) / (1000 * 60);
        return diffMinuti >= -5 && diffMinuti <= 30;
    })();

    // Estrazione della data della richiesta (formato YYYY-MM-DD) per il filtro rigido giornaliero
    const dataRichiestaStr = new Date(richiesta.start_datetime || new Date()).toISOString().split('T')[0];

    const promises = corseCandidate.map(async (c, index) => {
        if (!c) return null;
        c.classe = determinaClasse(Number(c.indice_efficienza || 0));

        const idString = typeof c.id === 'string' ? c.id : String(c.id || '');
        const isProattivo = idString.startsWith('virtual_pop_');
        
        // --- 🛑 FILTRO RIGIDO: LA CORSA DEVE PARTIRE IL GIORNO DELLA RICHIESTA ---
        if (!isProattivo && c.start_datetime) {
            const dataCorsaStr = new Date(c.start_datetime).toISOString().split('T')[0];
            if (dataCorsaStr !== dataRichiestaStr) {
                console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id}: scartata perché parte il ${dataCorsaStr} ma la richiesta è per il ${dataRichiestaStr}.`);
                return null;
            }
        }
        // -----------------------------------------------------------------------

        const startSnap = !isProattivo ? getSnapResult(pStart, c, TOLLERANZA_KM, c.id) : { ordine_sequenziale: 0 };
        const endSnap = !isProattivo ? getSnapResult(pEnd, c, TOLLERANZA_KM, c.id) : { ordine_sequenziale: 999 };

        if (!isProattivo && (!startSnap || !endSnap)) {
            console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id}: scartata perché startSnap o endSnap sono nulli.`);
            return null;
        }

        // --- CALCOLO CHILOMETRI OPERATIVI (Avvicinamento e Riposizionamento Reali) ---
        let kmAvvicinamento = 0;
        let kmRiposizionamento = 0;

        const veicoloIdRiferimento = c.veicolo_id;
        let dispVeicolo = veicoloIdRiferimento && CacheStore?.veicoloToDisponibilita ? CacheStore.veicoloToDisponibilita.get(Number(veicoloIdRiferimento)) : null;

        const latV = dispVeicolo ? (isImmediata ? (dispVeicolo.lat_live ?? dispVeicolo.lat_base) : dispVeicolo.lat_base) : c.lat_deposito;
        const lonV = dispVeicolo ? (isImmediata ? (dispVeicolo.lon_live ?? dispVeicolo.lon_base) : dispVeicolo.lon_base) : c.lon_deposito;
        const latBaseV = dispVeicolo ? dispVeicolo.lat_base : c.lat_deposito;
        const lonBaseV = dispVeicolo ? dispVeicolo.lon_base : c.lon_deposito;

        if (latV != null && lonV != null) {
            try {
                const infoAvv = await getDurataDistanza({ lat: Number(latV), lon: Number(lonV) }, { lat: richiesta.coord.lat, lon: richiesta.coord.lon });
                if (infoAvv?.distanzaKm) {
                    kmAvvicinamento = infoAvv.distanzaKm;
                } else {
                    kmAvvicinamento = turf.distance(turf.point([Number(lonV), Number(latV)]), pStart, { units: 'kilometers' });
                }
            } catch (e) {
                kmAvvicinamento = turf.distance(turf.point([Number(lonV), Number(latV)]), pStart, { units: 'kilometers' });
            }
        }

        if (latBaseV != null && lonBaseV != null) {
            try {
                const infoRip = await getDurataDistanza({ lat: richiesta.coordDest.lat, lon: richiesta.coordDest.lon }, { lat: Number(latBaseV), lon: Number(lonBaseV) });
                if (infoRip?.distanzaKm) {
                    kmRiposizionamento = infoRip.distanzaKm;
                } else {
                    kmRiposizionamento = turf.distance(pEnd, turf.point([Number(lonBaseV), Number(latBaseV)]), { units: 'kilometers' });
                }
            } catch (e) {
                kmRiposizionamento = turf.distance(pEnd, turf.point([Number(lonBaseV), Number(latBaseV)]), { units: 'kilometers' });
            }
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

            // Calcoliamo i passeggeri già presenti nel tratto richiesto
            let postiOccupatiNelTratto = 0;
            for (const p of prenotazioni) {
                const pStartTratto = Number(p.start_index_polyline ?? p.startOffset ?? 0);
                const pEndTratto = Number(p.end_index_polyline ?? p.endOffset ?? 0);
                if (startOffset < pEndTratto && endOffset > pStartTratto) {
                    postiOccupatiNelTratto += Number(p.posti_richiesti || 0);
                }
            }

            if ((postiOccupatiNelTratto + Number(richiesta.posti_richiesti)) > capacitaTotale) {
                console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id}: scartata per saturazione posti nel tratto.`);
                return null;
            }

            console.log(`✅ [SUCCESSO FILTER] Corsa ID ${c.id} superata con successo! Tratto occupato da: ${postiOccupatiNelTratto} passeggeri.`);
            return {
                ...c,
                km_avvicinamento: kmAvvicinamento,
                km_riposizionamento: kmRiposizionamento,
                passeggeri_correnti: postiOccupatiNelTratto
            };
        }

        // --- LOGICA POP-BUS (Universale) ---
        const baseResult = { 
            ...c, 
            veicoli_pool_ids: c.veicoli_pool_ids || [],
            km_avvicinamento: kmAvvicinamento,
            km_riposizionamento: kmRiposizionamento
        };

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
    });

    const risultati = await Promise.all(promises);
    return {
        corse: risultati.filter(Boolean)
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