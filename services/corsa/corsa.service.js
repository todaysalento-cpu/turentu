import { pool } from '../../db/db.js';
import * as prenotazioneService from '../prenotazione/prenotazione.service.js';
import { CacheManager } from '../../utils/cacheManager.js';
import { getRouteGeometry } from '../../utils/maps.util.js'; 
import polyline from 'polyline';
import ngeohash from 'ngeohash';
import { upsertCorsa } from '../search/search.cache.js'; 

// --- FUNZIONE DI SUPPORTO PER POPBUS ---
export async function createCorsaFromDirettrice(direttriceId, autistaId, client) {
    console.log(`🚌 [POPBUS] Creazione corsa da direttrice ID: ${direttriceId} per autista ID: ${autistaId}`);
    
    // 1. Recupero della direttrice virtuale (contenitore logico)
    const dirRes = await client.query(`
        SELECT * FROM direttrici_virtuali WHERE id = $1`, [direttriceId]);
    
    const d = dirRes.rows[0];
    if (!d) {
        throw new Error(`Direttrice virtuale con ID ${direttriceId} non trovata nel database.`);
    }

    // 2. Recupero delle richieste PopBus collegate a questa direttrice
    const reqsRes = await client.query(`
        SELECT * FROM richieste_pop_bus WHERE direttrice_id = $1`, [direttriceId]
    );
    const richieste = reqsRes.rows;

    // Calcolo posti prenotati totali
    const postiPrenotatiTotali = richieste.reduce((acc, r) => acc + (Number(r.posti_richiesti) || 1), 0);

    // Determina indirizzi e coordinate
    let origineAddress = 'N/D';
    let destinazioneAddress = 'N/D';
    const coordOrig = { lat: Number(d.origine_lat || 0), lon: Number(d.origine_lon || 0) };
    const coordDest = { lat: Number(d.destinazione_lat || 0), lon: Number(d.destinazione_lon || 0) };

    if (richieste.length > 0) {
        if (richieste[0].origine_address) origineAddress = richieste[0].origine_address;
        if (richieste[richieste.length - 1].destinazione_address) destinazioneAddress = richieste[richieste.length - 1].destinazione_address;
    }

    // Costruisci fermate_pianificate
    const fermatePianificate = [];
    for (const r of richieste) {
        if (r.origine) {
            fermatePianificate.push({
                tipo: 'ritiro',
                cliente_id: r.cliente_id,
                indirizzo: r.origine_address || 'N/D',
                lat: coordOrig.lat,
                lon: coordOrig.lon
            });
        }
        if (r.destinazione) {
            fermatePianificate.push({
                tipo: 'rilascio',
                cliente_id: r.cliente_id,
                indirizzo: r.destinazione_address || 'N/D',
                lat: coordDest.lat,
                lon: coordDest.lon
            });
        }
    }

    // 3. Ricerca sicura del veicolo
    let veicoloIdFinal = null;
    let postiTotaliFinal = 4; // Fallback di sicurezza

    const veicoloRes = await client.query(`
        SELECT id, posti_totali FROM veicolo WHERE driver_id = $1 LIMIT 1`, 
        [autistaId]
    );

    if (veicoloRes.rows.length > 0) {
        veicoloIdFinal = veicoloRes.rows[0].id;
        postiTotaliFinal = veicoloRes.rows[0].posti_totali || 4;
    } else {
        const segVeicoloRes = await client.query(`
            SELECT v.id, v.posti_totali 
            FROM segmenti s
            JOIN veicolo v ON v.id = s.veicolo_id
            WHERE s.direttrice_id = $1 AND s.stato = 'attivo'
            LIMIT 1`, [direttriceId]
        );
        if (segVeicoloRes.rows.length > 0) {
            veicoloIdFinal = segVeicoloRes.rows[0].id;
            postiTotaliFinal = segVeicoloRes.rows[0].posti_totali || 4;
        }
    }

    if (!veicoloIdFinal) {
        throw new Error(`Impossibile determinare il veicolo per la creazione della corsa PopBus (Direttrice ${direttriceId}, Autista ${autistaId}).`);
    }

    const postiDisponibiliFinal = Math.max(0, postiTotaliFinal - postiPrenotatiTotali);
    let distanzaKm = Number(d.distanza_totale_km || 0);

    // Generazione geometria e distanza se mancanti
    let polylineString = '';
    let pathGeohashes = [];
    try {
        if (coordOrig.lat && coordOrig.lon && coordDest.lat && coordDest.lon) {
            const routeData = await getRouteGeometry(coordOrig, coordDest);
            polylineString = routeData?.polyline || '';
            if (routeData?.distanzaKm && distanzaKm === 0) {
                distanzaKm = routeData.distanzaKm;
            }
            if (polylineString) {
                const coords = polyline.decode(polylineString);
                const step = Math.max(1, Math.floor(coords.length / 10));
                pathGeohashes = coords.filter((_, index) => index % step === 0).map(c => ngeohash.encode(c[0], c[1], 5));
            }
        }
    } catch (e) {
        console.warn(`⚠ [POPBUS ROUTE WARNING] Impossibile generare geometria per direttrice ${direttriceId}:`, e);
    }

    // 4. Inserimento della corsa con tutti i campi valorizzati
    const res = await client.query(`
        INSERT INTO corse (
            veicolo_id, tipo_corsa, stato, start_datetime, posti_totali, posti_disponibili, posti_prenotati,
            origine, destinazione, origine_address, destinazione_address, distanza,
            fermate_pianificate, percorso_polyline, path_geohashes, created_at
        ) VALUES ($1, 'riempimento', 'prenotabile', $2, $3, $4, $5,
            ST_SetSRID(ST_MakePoint($6,$7),4326), 
            ST_SetSRID(ST_MakePoint($8,$9),4326),
            $10, $11, $12, $13::jsonb, $14, $15, NOW()
        ) RETURNING *`, 
        [
            veicoloIdFinal,
            d.partenza_prevista,
            postiTotaliFinal,
            postiDisponibiliFinal,
            postiPrenotatiTotali,
            coordOrig.lon,
            coordOrig.lat,
            coordDest.lon,
            coordDest.lat,
            origineAddress,
            destinazioneAddress,
            distanzaKm,
            JSON.stringify(fermatePianificate),
            polylineString,
            pathGeohashes
        ]
    );

    const corsa = res.rows[0];
    
    // 5. Aggiornamento delle richieste PopBus collegate
    await client.query(`
        UPDATE richieste_pop_bus 
        SET stato = 'convertita', corsa_id = $1 
        WHERE direttrice_id = $2`, 
        [corsa.id, direttriceId]);
    
    console.log(`✅ [POPBUS] Corsa ID ${corsa.id} creata con successo.`);
    return corsa;
}

// Validazioni geografiche esclusivamente per nuove missioni NCC condivise.
function coordinateBaseValide(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) &&
        Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
        !(lat === 0 && lon === 0);
}

function erroreGeoNcc(messaggio) {
    const err = new Error(messaggio);
    err.code = 'NCC_MISSION_GEO_INVALID';
    return err;
}

function stessoPunto(a, b) {
    return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
}

// Per la sola tratta di avvicinamento NCC, distanze geodetiche <= 50 m
// sono trascurabili. Oltre la soglia e' obbligatorio il routing stradale.
function distanzaAriaMetriNcc(a, b) {
    const rad = Math.PI / 180;
    const lat1 = a.lat * rad, lat2 = b.lat * rad;
    const deltaLat = (b.lat - a.lat) * rad;
    const deltaLon = (b.lon - a.lon) * rad;
    const h = Math.sin(deltaLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function distanzaTrattaNcc(da, a, nome, { conDurata = false } = {}) {
    if (!coordinateBaseValide(Number(da?.lat), Number(da?.lon)) ||
        !coordinateBaseValide(Number(a?.lat), Number(a?.lon))) {
        throw erroreGeoNcc(`Coordinate ${nome} non valide`);
    }
    const metriAria = distanzaAriaMetriNcc(da, a);
    // Entro 50 m l'avvicinamento e' trascurabile: non serve interrogare il routing.
    if (nome === 'avvicinamento' && metriAria <= 50) {
        console.log(`[NCC ROUTING] Avvicinamento trascurabile: ${metriAria.toFixed(2)} m (soglia 50 m).`);
        return conDurata ? { km: 0, durataSecondi: 0 } : 0;
    }
    let route;
    try {
        route = await getRouteGeometry(da, a);
    } catch (err) {
        throw erroreGeoNcc(`Routing ${nome} non disponibile: ${err.message}`);
    }
    // Number(null) e Number('') sono zero: non confonderli con una risposta valida.
    const rawKm = route?.distanzaKm;
    const km = rawKm == null || rawKm === '' ? NaN : Number(rawKm);
    if (Number.isFinite(km) && km > 0) {
        if (!conDurata) return km;
        const durataSecondi = route?.durata == null ? NaN : Number(route.durata);
        if (!Number.isFinite(durataSecondi) || durataSecondi <= 0) {
            throw erroreGeoNcc(`Durata stradale ${nome} non valida`);
        }
        return { km, durataSecondi };
    }
    console.error('[NCC ROUTING] Distanza non valida', {
        nome, da, a, metriAria: Number(metriAria.toFixed(2)),
        distanzaKmRicevuta: rawKm ?? null,
        durataRicevuta: route?.durata ?? null,
        polylinePresente: Boolean(route?.polyline)
    });
    throw erroreGeoNcc(`Distanza stradale ${nome} non valida`);
}

// --- FUNZIONE PRINCIPALE ---
export async function createCorsaFromPending(pending, veicolo, client, isPopBus = false, autistaId = null) {
  let localClient = false;
  if (!client) {
    client = await pool.connect();
    localClient = true;
  }

  try {
    if (localClient) await client.query('BEGIN');

    let corsa;

    // --- LOGICA BIVIO: POPBUS O PRIVATE/CONDIVISA ---
    if (isPopBus) {
        corsa = await createCorsaFromDirettrice(pending.direttrice_id, autistaId, client);
    } else {
        // --- LOGICA PRIVATE / CONDIVISA ---
        const startDatetime = new Date(pending.start_datetime || pending.startDatetime);
        const rawDurata = pending.durataMinuti ?? pending.durata_minuti ?? pending.durata;
         const durataMin = typeof rawDurata === 'string' && rawDurata.includes(':')
           ? rawDurata.split(':').map(Number).reduce((acc, n, i) => acc + n * [60, 1, 1/60][i], 0)
           : Number(rawDurata);
         if (!Number.isFinite(durataMin) || durataMin <= 0) throw new Error('Durata pending mancante o non valida');
        const arrivoDatetime = new Date(startDatetime.getTime() + durataMin * 60 * 1000);

        // Estrazione sicura delle coordinate con fallback multipli ed espliciti
        const coordOrig = {
            lat: Number(pending.origine_lat ?? pending.coordOrigine?.lat ?? 0),
            lon: Number(pending.origine_lon ?? pending.coordOrigine?.lon ?? 0)
        };

        const coordDest = {
            lat: Number(pending.destinazione_lat ?? pending.coordDestinazione?.lat ?? 0),
            lon: Number(pending.destinazione_lon ?? pending.coordDestinazione?.lon ?? 0)
        };

        console.log(`📍 [CREATE CORSA] Pending ID ${pending.id} - Origine estratta:`, coordOrig);
        console.log(`🏁 [CREATE CORSA] Pending ID ${pending.id} - Destinazione estratta:`, coordDest);

        if (coordOrig.lat === 0 || coordOrig.lon === 0 || coordDest.lat === 0 || coordDest.lon === 0) {
            console.error(`❌ [CREATE CORSA ERRORE] Coordinate non valide per il pending ${pending.id}`);
            throw new Error(`Coordinate di origine o destinazione non valide per il pending ${pending.id}`);
        }

        const isNccCondivisa = pending.tipo_corsa === 'condivisa';
        let kmAvvicinamento = 0;
        let kmRiposizionamento = 0;
        let percorsoRitornoNcc = null;
        let durataAvvicinamentoSecondi = null;
        let durataRientroSecondi = null;

        // Le missioni NCC condivise richiedono una base reale e due tratte
        // stradali affidabili. Non usare l'origine del cliente come base fittizia.
        if (isNccCondivisa) {
            const latBase = veicolo?.lat_base == null ? NaN : Number(veicolo.lat_base);
            const lonBase = veicolo?.lon_base == null ? NaN : Number(veicolo.lon_base);
            if (!coordinateBaseValide(latBase, lonBase)) {
                throw erroreGeoNcc(`Base operativa mancante o non valida per veicolo ${veicolo?.id ?? pending.veicolo_id}`);
            }
            const base = { lat: latBase, lon: lonBase };
            const avvicinamento = await distanzaTrattaNcc(base, coordOrig, 'avvicinamento', { conDurata: true });
            kmAvvicinamento = avvicinamento.km;
            durataAvvicinamentoSecondi = avvicinamento.durataSecondi;
            // La tratta di ritorno e' una direzione commerciale autonoma della stessa missione.
            // Conserviamo geometria e durata, oltre ai km gia' conteggiati nel costo fisso.
            if (stessoPunto(coordDest, base)) {
                throw erroreGeoNcc('Ritorno commerciale assente: destinazione coincidente con la base');
            }
            try {
                percorsoRitornoNcc = await getRouteGeometry(coordDest, base);
            } catch (err) {
                throw erroreGeoNcc(`Routing ritorno alla base non disponibile: ${err.message}`);
            }
            const kmRitorno = Number(percorsoRitornoNcc?.distanzaKm);
            const durataRitorno = Number(percorsoRitornoNcc?.durata);
            if (!percorsoRitornoNcc?.polyline || !Number.isFinite(kmRitorno) || kmRitorno <= 0 ||
                !Number.isFinite(durataRitorno) || durataRitorno <= 0) {
                throw erroreGeoNcc('Geometria, distanza o durata del ritorno non valide');
            }
            kmRiposizionamento = kmRitorno;
            durataRientroSecondi = durataRitorno;
        } else {
            // Comportamento storico delle corse private, salvo correzione
            // della longitudine usata per il ritorno.
            try {
                const latBaseV = Number(veicolo?.lat_base ?? veicolo?.lat_deposito);
                const lonBaseV = Number(veicolo?.lon_base ?? veicolo?.lon_deposito);
                if (latBaseV && lonBaseV) {
                    const routeAvv = await getRouteGeometry({ lat: latBaseV, lon: lonBaseV }, coordOrig);
                    if (routeAvv?.distanzaKm) kmAvvicinamento = routeAvv.distanzaKm;
                    if (Number.isFinite(Number(routeAvv?.durata)) && Number(routeAvv?.durata) > 0)
                        durataAvvicinamentoSecondi = Number(routeAvv.durata);
                    const routeRip = await getRouteGeometry(coordDest, { lat: latBaseV, lon: lonBaseV });
                    if (routeRip?.distanzaKm) kmRiposizionamento = routeRip.distanzaKm;
                    if (Number.isFinite(Number(routeRip?.durata)) && Number(routeRip?.durata) > 0)
                        durataRientroSecondi = Number(routeRip.durata);
                }
            } catch (e) {
                console.warn('⚠ [ROUTING WARNING] Errore calcolo avvicinamento/riposizionamento:', e);
            }
        }
        console.log(`📏 [MISSIONE FISSA STRADALE] Avvicinamento: ${kmAvvicinamento.toFixed(2)} km, Riposizionamento: ${kmRiposizionamento.toFixed(2)} km`);

        let polylineString = '';
        let pathGeohashes = [];
        let distanzaKm = Number(pending.distanza) || 0;

        try {
            console.log(`🗺 [ROUTE] Richiesta geometria rotta stradale principale per pending ${pending.id}...`);
            const routeData = await getRouteGeometry(coordOrig, coordDest); 
            
            polylineString = routeData?.polyline || '';
            if (routeData?.distanzaKm) {
                distanzaKm = routeData.distanzaKm;
            }

            if (polylineString) {
                const coords = polyline.decode(polylineString);
                const step = Math.max(1, Math.floor(coords.length / 10));
                pathGeohashes = coords.filter((_, index) => index % step === 0).map(c => ngeohash.encode(c[0], c[1], 5));
                console.log(`✅ [ROUTE] Geometria generata. Distanza: ${distanzaKm} km`);
            }
        } catch (e) {
            if (isNccCondivisa) {
                throw erroreGeoNcc(`Routing percorso principale non disponibile per pending ${pending.id}: ${e.message}`);
            }
            console.warn(`⚠ [ROUTE WARNING] Impossibile generare geometria per pending ${pending.id}:`, e);
        }
        if (isNccCondivisa && (!Number.isFinite(distanzaKm) || distanzaKm <= 0 || !polylineString)) {
            throw erroreGeoNcc(`Percorso stradale principale incompleto per pending ${pending.id}`);
        }

        const postiTotaliVeicolo = Number(veicolo?.posti_totali ?? veicolo?.posti ?? 4);
        const veicoloId = veicolo?.id ?? pending.veicolo_id;

        const res = await client.query(
          `INSERT INTO corse (
             veicolo_id, start_datetime, arrivo_datetime, tipo_corsa, stato, durata, 
             posti_totali, posti_disponibili, distanza, origine, destinazione, 
             origine_address, destinazione_address, percorso_polyline, path_geohashes, 
             km_avvicinamento, km_riposizionamento, created_at
           )
           VALUES (
             $1, $2, $3, $4, 'prenotabile', $5, 
             $6, $6, $7, ST_SetSRID(ST_MakePoint($8,$9),4326), ST_SetSRID(ST_MakePoint($10,$11),4326), 
             $12, $13, $14, $15, $16, $17, NOW()
           ) RETURNING *`,
          [
            veicoloId,                            // $1
            startDatetime,                        // $2
            arrivoDatetime,                       // $3
            (pending.tipo_corsa === 'privata' ? 'privata' : 'condivisa'), // $4
            `${durataMin} minutes`,               // $5
            postiTotaliVeicolo,                   // $6
            distanzaKm,                           // $7
            coordOrig.lon,                        // $8
            coordOrig.lat,                        // $9
            coordDest.lon,                        // $10
            coordDest.lat,                        // $11
            (pending.origine_address ?? 'N/D'),    // $12
            (pending.destinazione_address ?? 'N/D'), // $13
            polylineString,                       // $14
            pathGeohashes,                        // $15
            kmAvvicinamento,                      // $16
            kmRiposizionamento                    // $17
          ]
        );
        corsa = res.rows[0];

        // Riserva conservativa del ciclo: avvicinamento, servizio e rientro.
        // Per la condivisa il ritorno resta flessibile entro il buffer del matching.
        const bufferRitornoMinuti = distanzaKm <= 15 ? 20 :
            distanzaKm <= 30 ? 30 : distanzaKm <= 60 ? 45 :
            distanzaKm <= 100 ? 60 : distanzaKm <= 150 ? 90 : 120;
        const durateValide = [durataAvvicinamentoSecondi, durataRientroSecondi]
            .every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0);
        const inizioCiclo = durateValide
            ? new Date(startDatetime.getTime() - durataAvvicinamentoSecondi * 1000)
            : null;
        const fineCiclo = durateValide
            ? new Date(arrivoDatetime.getTime() +
                (isNccCondivisa ? bufferRitornoMinuti * 60000 : 0) +
                durataRientroSecondi * 1000)
            : null;
        // Dato transitorio non enumerabile, non scritto nel DB.
        Object.defineProperty(corsa, 'cicloOperativoNcc', {
            value: durateValide && Number.isFinite(inizioCiclo.getTime()) &&
                Number.isFinite(fineCiclo.getTime()) && fineCiclo > inizioCiclo
                ? {
                    inizio: inizioCiclo.toISOString(),
                    fine: fineCiclo.toISOString(),
                    durataAvvicinamentoSecondi,
                    durataRientroSecondi,
                    bufferRitornoMinuti: isNccCondivisa ? bufferRitornoMinuti : 0
                }
                : null,
            enumerable: false
        });
        console.log(`✅ [DB] Corsa ID ${corsa?.id} inserita correttamente.`);

        // --- GESTIONE E LOGGING DEGLI OFFSET E INDICI ---
        const distanzaMetriTotali = distanzaKm * 1000;
        const startOffsetVal = Number(pending.start_offset ?? pending.startOffset ?? 0);
        const endOffsetVal = Number(pending.end_offset ?? pending.endOffset ?? (distanzaMetriTotali > 0 ? distanzaMetriTotali : 1000));

        const startIdxVal = Number(pending.start_index_polyline ?? pending.startIndexPolyline ?? 0);
        const endIdxVal = Number(pending.end_index_polyline ?? pending.endIndexPolyline ?? 100);
        let trattaInizialeId = null;
        if (isNccCondivisa) {
          // La prima prenotazione deve avere una tratta reale e programmata.
          const { rows: tratteCreate } = await client.query(`
            INSERT INTO public.corse_tratte (
              corsa_id, direzione, percorso_polyline, distanza_km, durata_secondi,
              partenza_prevista, arrivo_previsto, stato_temporale
            ) VALUES ($1, 'andata', $2, $3, $4, $5, $6, 'programmato') RETURNING id
          `, [corsa.id, polylineString, distanzaKm, Math.round(durataMin * 60), startDatetime, arrivoDatetime]);
          trattaInizialeId = Number(tratteCreate[0].id);

          // Ritorno indipendente: nessun orario definitivo e nessuna prima prenotazione.
          // Il buffer dinamico verra' verificato dal matching prima della prima accettazione.
          // Il passaggio a "programmato" deve avvenire nella transazione di accettazione.
          await client.query(`
            INSERT INTO public.corse_tratte (
              corsa_id, direzione, percorso_polyline, distanza_km, durata_secondi,
              partenza_prevista, arrivo_previsto, stato_temporale, prima_prenotazione_id
            ) VALUES ($1, 'ritorno', $2, $3, $4, NULL, NULL, 'flessibile', NULL)
          `, [
            corsa.id,
            percorsoRitornoNcc.polyline,
            Number(percorsoRitornoNcc.distanzaKm),
            Math.round(Number(percorsoRitornoNcc.durata))
          ]);
        }

        const segmenti = {  
            startIdx: startIdxVal,  
            endIdx: endIdxVal,
            startOffset: startOffsetVal,
            endOffset: endOffsetVal,
            latSalita: coordOrig.lat,   
            lonSalita: coordOrig.lon,   
            latDiscesa: coordDest.lat,  
            lonDiscesa: coordDest.lon,
            tratta_id: trattaInizialeId
        };

        const prenotazione = await prenotazioneService.prenotaCorsa(
            corsa, 
            pending.cliente_id ?? pending.clienteId, 
            Number(pending.posti_richiesti ?? 1), 
            segmenti, 
            client
        );
        
        if (trattaInizialeId) {
          await client.query(`UPDATE public.corse_tratte SET prima_prenotazione_id=$1
            WHERE id=$2 AND corsa_id=$3`, [prenotazione.id, trattaInizialeId, corsa.id]);
        }
        console.log(`✅ [DB] Prenotazione ID ${prenotazione?.id} creata con successo per la corsa ${corsa.id}.`);
        await client.query(`UPDATE pagamenti SET corsa_id = $1 WHERE prenotazione_id = $2`, [corsa.id, prenotazione.id]);
    }

    if (localClient) {
      await client.query('COMMIT');
      try { CacheManager.corsa.update(corsa); upsertCorsa(corsa); }
      catch (e) { console.error('[CORSA CACHE POSTCOMMIT]', e.message); }
    }
    return corsa;

  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    console.error(`❌ [ERROR] Fallimento in createCorsaFromPending per pending ID ${pending?.id}:`, err);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}