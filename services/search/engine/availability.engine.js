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

    if (isAnchor) {
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
                    const offsetMetri = snapped.properties.location * lunghezzaMetri;
                    
                    console.log(`📍 [SNAP CONDIVISA] Corsa ${corsaId}: Distanza snap = ${snapped.properties.dist.toFixed(3)} km | Offset calcolato = ${offsetMetri.toFixed(2)} m (Lunghezza totale polyline: ${lunghezzaMetri.toFixed(2)} m)`);

                    return {
                        offset_metri: offsetMetri,
                        type: 'DYNAMIC',
                        dist: snapped.properties.dist
                    };
                } else {
                    console.log(`⚠️ [SNAP FALLITO] Corsa ${corsaId}: Distanza dal percorso di ${snapped.properties.dist.toFixed(2)} km superiore alla tolleranza (${tolleranzaKm} km)`);
                }
            } catch (e) {
                console.error(`⚠ [SNAP ERROR] Corsa ${corsaId}:`, e);
            }
        } else {
            console.log(`⚠ [SNAP FALLITO] Corsa ${corsaId}: percorso_polyline mancante.`);
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

        const startSnap = !isProattivo ? getSnapResult(pStart, c, TOLLERANZA_KM, c.id, latV, lonV, latBaseV, lonBaseV) : { ordine_sequenziale: 0 };
        const endSnap = !isProattivo ? getSnapResult(pEnd, c, TOLLERANZA_KM, c.id, latV, lonV, latBaseV, lonBaseV) : { ordine_sequenziale: 999 };

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
            const kmTotaliCorsaOriginale = Number(c.km_totali_percorso) || 1; // In metri o km a seconda dello standard, verifichiamo la proporzione

            for (const p of prenotazioni) {
                const pStartTratto = Number(p.start_index_polyline ?? p.startOffset ?? 0);
                const pEndTratto = Number(p.end_index_polyline ?? p.endOffset ?? 0);

                console.log(`   ➡️ Analisi prenotazione ID ${p.id}: start=${pStartTratto}, end=${pEndTratto}, posti=${p.posti_richiesti}`);

                if (startOffset < pEndTratto && endOffset > pStartTratto) {
                    postiOccupatiNelTratto += Number(p.posti_richiesti || 0);
                }

                // Calcolo della percentuale di occupazione della singola prenotazione esistente rispetto alla corsa originale
                // Nota: se start_index_polyline ed end_index_polyline sono in metri sulla polyline totale:
                const lunghezzaTrattaPaz = Math.max(0, pEndTratto - pStartTratto);
                // Se la polyline totale è espressa in metri totali o span 0-100, rapportiamola correttamente:
                // Se i valori sono in metri puri lungo la polyline:
                let percPaz = lunghezzaTrattaPaz / (c.lunghezza_metri_totali || kmTotaliCorsaOriginale * 1000 || 100);
                // Fall tuttavia sicurezza nel caso i valori siano 0-100 percentuali o simili:
                if (pEndTratto <= 100 && pStartTratto === 0) {
                    percPaz = (pEndTratto - pStartTratto) / 100;
                }
                percPaz = Math.min(1.0, Math.max(0.01, percPaz)); // Evitiamo percentuali zero o assurde

                percentualiEsistentiArray.push(percPaz);
            }

            console.log(`📊 [PERCENTUALI ESISTENTI CALCOLATE] Corsa ID ${c.id}:`, percentualiEsistentiArray);

            if ((postiOccupatiNelTratto + Number(richiesta.posti_richiesti)) > capacitaTotale) {
                console.log(`❌ [SCARTO FILTER] Corsa ID ${c.id}: scartata per saturazione posti nel tratto globale (Occupati: ${postiOccupatiNelTratto}, Richiesti: ${richiesta.posti_richiesti}, Capacità: ${capacitaTotale}).`);
                return null;
            }

            const kmUtenteTratta = (endOffset - startOffset) / 1000;

            console.log(`✅ [SUCCESSO FILTER] Corsa ID ${c.id} superata con successo! Tratto utente pulito: ${kmUtenteTratta.toFixed(3)} km.`);
            return {
                ...c,
                km_avvicinamento: kmAvvicinamento,
                km_riposizionamento: kmRiposizionamento,
                passeggeri_correnti: postiOccupatiNelTratto,
                calculated_start_offset: startOffset,
                calculated_end_offset: endOffset,
                km_utente: kmUtenteTratta,
                percentuali_passeggeri_esistenti: percentualiEsistentiArray // <--- Passato correttamente al pricing!
            };
        }

        // --- LOGICA POP-BUS ---
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