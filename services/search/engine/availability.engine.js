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
 * SNAP LOGIC CORRETTA (Sulla tratta principale della corsa)
 */
function getSnapResult(point, corsa, tolleranzaKm, corsaId, latV, lonV, latBaseV, lonBaseV) {
    const isAnchor = corsa.tipo_corsa === 'condivisa';

    if (isAnchor || corsa.percorso_polyline) {
        if (corsa.percorso_polyline) {
            try {
                const decoded = polyline.decode(corsa.percorso_polyline);
                const coordinatesPrincipali = decoded.map(c => [c[1], c[0]]); // [lon, lat]
                
                if (coordinatesPrincipali.length < 2) {
                    console.log(`⚠️ [SNAP ERROR] Corsa ${corsaId}: polyline decodificata ha meno di 2 punti.`);
                    return null;
                }
                
                const line = turf.lineString(coordinatesPrincipali);
                const snapped = turf.nearestPointOnLine(line, point, { units: 'kilometers' });

                if (snapped.properties.dist <= tolleranzaKm) {
                    const lunghezzaMetri = turf.length(line, { units: 'meters' });
                    const offsetMetri = Math.min(lunghezzaMetri, snapped.properties.location * 1000);
                    
                    console.log(`📍 [SNAP GEO] Corsa ${corsaId}: Distanza snap = ${snapped.properties.dist.toFixed(3)} km | Offset calcolato = ${offsetMetri.toFixed(2)} m (Lunghezza totale polyline: ${lunghezzaMetri.toFixed(2)} m)`);

                    return {
                        offset_metri: offsetMetri,
                        type: 'DYNAMIC',
                        dist: snapped.properties.dist
                    };
                } else {
                    console.log(`⚠ [SNAP FALLITO] Corsa ${corsaId}: Distanza dal percorso di ${snapped.properties.dist.toFixed(2)} km superiore alla tolleranza (${tolleranzaKm} km)`);
                }
            } catch (e) {
                console.error(`⚠ [SNAP ERROR] Corsa ${corsaId}:`, e);
            }
        } else {
            console.log(`⚠ [SNAP FALLITO] Corsa ${corsaId}: percorso_polyline mancante.`);
        }
        if (isAnchor) return null;
    }

    const nodi = corsa.nodi_sequenza || [];
    let nearest = null;
    let min = tolleranzaKm;
    let nearestIndex = 0;

    for (let i = 0; i < nodi.length; i++) {
        const n = nodi[i];
        const d = turf.distance(point, turf.point([n.lon, n.lat]), { units: 'kilometers' });
        if (d < min) {
            min = d;
            nearest = { ...n, type: 'STATIC', dist: d, indice_nodo: i };
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
    console.log(`\n🔍 [AVAILABILITY ENGINE] Inizio elaborazione di ${corseCandidate?.length || 0} corse candidate.`);

    const pStart = turf.point([richiesta.coord.lon, richiesta.coord.lat]);
    const pEnd = turf.point([richiesta.coordDest.lon, richiesta.coordDest.lat]);
    const TOLLERANZA_KM = 50.0;
    
    const isImmediata = (() => {
        const orarioAndataUtente = new Date(richiesta.start_datetime || new Date());
        const diffMinuti = (orarioAndataUtente.getTime() - new Date().getTime()) / (1000 * 60);
        return diffMinuti >= -5 && diffMinuti <= 30;
    })();

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

        // --- CALCOLO CHILOMETRI OPERATIVI & POSIZIONI ---
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

        const startSnap = !isProattivo ? getSnapResult(pStart, c, TOLLERANZA_KM, c.id, latV, lonV, latBaseV, lonBaseV) : { ordine_sequenziale: 0, offset_metri: 0 };
        const endSnap = !isProattivo ? getSnapResult(pEnd, c, TOLLERANZA_KM, c.id, latV, lonV, latBaseV, lonBaseV) : { ordine_sequenziale: 999, offset_metri: Number(c.lunghezza_metri_totali || 1000) };

        if (!isProattivo && (!startSnap || !endSnap)) {
            console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id}: scartata perché startSnap o endSnap sono nulli.`);
            return null;
        }

        // --- LOGICA CONDIVISA ---
        if (c.tipo_corsa === 'condivisa') {
            const startOffset = Number(startSnap.offset_metri);
            const endOffset = Number(endSnap.offset_metri);
            
            console.log(`👥 [CHECK CONDIVISA] Corsa ID ${c.id} | Start Offset: ${startOffset.toFixed(2)}m | End Offset: ${endOffset.toFixed(2)}m`);

            if (startOffset >= endOffset || (endOffset - startOffset) < 500) {  
                console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id}: offset non validi o tratto troppo corto (start: ${startOffset}, end: ${endOffset}).`);
                return null;
            }

            // Recupero prenotazioni batch per questa specifica corsa all'indice corrente
            const prenotazioni = Array.isArray(prenotazioniBatch?.[index]) ? prenotazioniBatch[index] : [];
            console.log(`📦 [PRENOTAZIONI BATCH] Corsa ID ${c.id} (indice ${index}): trovate ${prenotazioni.length} prenotazioni nel DB.`, prenotazioni);

            const capacitaTotale = capacitaMap.get(c.id) ?? Number(c.posti_totali || 0);

            let postiOccupatiNelTratto = 0;
            const percentualiEsistentiArray = [];
            const kmTotaliCorsaOriginale = Number(c.km_totali_percorso) || 1;
            
            // Lunghezza totale di sicurezza (priorità a c.lunghezza_metri_totali, fallback sui km originali)
            const lunghezzaTotaleMetri = Number(c.lunghezza_metri_totali) || (kmTotaliCorsaOriginale * 1000);

            for (const p of prenotazioni) {
                const pStartTratto = Number(p.start_offset ?? p.start_index_polyline ?? 0);
                const pEndTratto = Number(p.end_offset ?? p.end_index_polyline ?? 0);

                if (startOffset < pEndTratto && endOffset > pStartTratto) {
                    postiOccupatiNelTratto += Number(p.posti_richiesti || 0);
                }

                // Calcolo percentuale basato sui metri reali (senza glitch legati a soglie fisse)
                const lunghezzaTrattaPaz = Math.max(0, pEndTratto - pStartTratto);
                let percPaz = lunghezzaTrattaPaz / lunghezzaTotaleMetri;
                percPaz = Math.min(1.0, Math.max(0.01, percPaz));

                percentualiEsistentiArray.push(percPaz);
            }

            if ((postiOccupatiNelTratto + Number(richiesta.posti_richiesti)) > capacitaTotale) {
                console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id}: scartata per saturazione posti nel tratto globale (Occupati: ${postiOccupatiNelTratto}, Richiesti: ${richiesta.posti_richiesti}, Capacità: ${capacitaTotale}).`);
                return null;
            }

            const kmUtenteTratta = (endOffset - startOffset) / 1000;

            // --- ⏱️ LOGICA CALCOLO ORARIO DI PARTENZA DINAMICO (ORIGINE INTERMEDIA) ---
            let oraPartenzaUtente = c.partenza_prevista || c.partenza;
            console.log(`🕒 [ORARIO DINAMICO - START] Corsa ID ${c.id} | Partenza originale corsa: ${oraPartenzaUtente} | startOffset: ${startOffset.toFixed(2)}m`);

            if (startOffset > 0 && lunghezzaTotaleMetri > 0 && c.partenza_prevista) {
                const dPartenzaOriginale = new Date(c.partenza_prevista);
                if (!isNaN(dPartenzaOriginale.getTime())) {
                    const durataTotaleMs = Number(c.durata_totale_ms || (kmTotaliCorsaOriginale * 60 * 1000));
                    
                    const frazionePercorso = Math.min(1, startOffset / lunghezzaTotaleMetri);
                    const ritardoMs = durataTotaleMs * frazionePercorso;
                    
                    console.log(`⏱️ [ORARIO DINAMICO - DETTAGLI] Durata totale corsa (ms): ${durataTotaleMs} | Lunghezza totale (m): ${lunghezzaTotaleMetri}`);
                    console.log(`⏱ [ORARIO DINAMICO - DETTAGLI] Frazione percorso completata prima dell'imbarco: ${(frazionePercorso * 100).toFixed(2)}%`);
                    console.log(`⏱️ [ORARIO DINAMICO - DETTAGLI] Ritardo calcolato per raggiungere il punto d'imbarco (ms): ${ritardoMs.toFixed(0)} (~${(ritardoMs / 60000).toFixed(1)} minuti)`);

                    const nuovoTimestamp = dPartenzaOriginale.getTime() + ritardoMs;
                    oraPartenzaUtente = new Date(nuovoTimestamp).toISOString();
                    console.log(`✅ [ORARIO DINAMICO - FINALE] Orario di partenza calcolato per l'utente: ${oraPartenzaUtente}`);
                } else {
                    console.log(`⚠️ [ORARIO DINAMICO - WARNING] Impossibile parsare 'partenza_prevista': ${c.partenza_prevista}`);
                }
            } else {
                console.log(`ℹ️ [ORARIO DINAMICO - INFO] L'utente parte dall'origine o dati mancanti (lunghezzaTotale: ${lunghezzaTotaleMetri}). Orario invariato: ${oraPartenzaUtente}`);
            }

            console.log(`✅ [SUCCESSO FILTER] Corsa ID ${c.id} superata con successo! Tratto utente pulito: ${kmUtenteTratta.toFixed(3)} km.`);
            return {
                ...c,
                km_avvicinamento: kmAvvicinamento,
                km_riposizionamento: kmRiposizionamento,
                passeggeri_correnti: postiOccupatiNelTratto,
                startOffset: startOffset,
                endOffset: endOffset,
                calculated_start_offset: startOffset,
                calculated_end_offset: endOffset,
                km_utente: kmUtenteTratta,
                percentuali_passeggeri_esistenti: percentualiEsistentiArray,
                partenza_effettiva: oraPartenzaUtente
            };
        }

        // --- LOGICA POP-BUS ---
        let startOffsetPop = Number(startSnap.offset_metri || 0);
        let endOffsetPop = Number(endSnap.offset_metri || 0);

        if (!startOffsetPop && c.percorso_polyline) {
            try {
                const decoded = polyline.decode(c.percorso_polyline);
                const line = turf.lineString(decoded.map(pt => [pt[1], pt[0]]));
                const lenM = turf.length(line, { units: 'meters' });
                startOffsetPop = 0;
                endOffsetPop = lenM;
            } catch (e) {
                startOffsetPop = 0;
                endOffsetPop = 1000;
            }
        }

        const baseResult = { 
            ...c, 
            veicoli_pool_ids: c.veicoli_pool_ids || [],
            km_avvicinamento: kmAvvicinamento,
            km_riposizionamento: kmRiposizionamento,
            startOffset: startOffsetPop,
            endOffset: endOffsetPop,
            calculated_start_offset: startOffsetPop,
            calculated_end_offset: endOffsetPop,
            km_utente: Math.max(0.1, (endOffsetPop - startOffsetPop) / 1000)
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
    const corseFiltrate = risultati.filter(Boolean);
    console.log(`🏁 [AVAILABILITY ENGINE] Completato. Corse valide restituite: ${corseFiltrate.length}\n`);

    return {
        corse: corseFiltrate
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