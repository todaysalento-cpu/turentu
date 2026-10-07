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

    // 2. Ricerca sicura del veicolo (tramite l'autista loggato o dai segmenti attivi della tratta)
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
        // Fallback sui segmenti attivi della direttrice
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

    // 3. Inserimento della corsa con tipo_corsa 'riempimento' e stato 'prenotabile' (senza direttrice_id)
    const res = await client.query(`
        INSERT INTO corse (
            autista_id, veicolo_id, tipo_corsa, stato, start_datetime, posti_totali, posti_disponibili,
            origine, destinazione
        ) VALUES ($1, $2, 'riempimento', 'prenotabile', $3, $4, $4, 
            ST_SetSRID(ST_MakePoint($5,$6),4326), 
            ST_SetSRID(ST_MakePoint($7,$8),4326))
        RETURNING *`, 
        [
            autistaId, 
            veicoloIdFinal, 
            d.partenza_prevista, 
            postiTotaliFinal, 
            d.origine_lon ?? 0, 
            d.origine_lat ?? 0, 
            d.destinazione_lon ?? 0, 
            d.destinazione_lat ?? 0
        ]
    );

    const corsa = res.rows[0];
    
    // 4. Aggiornamento delle richieste PopBus collegate
    await client.query(`
        UPDATE richieste_pop_bus 
        SET stato = 'confermata', corsa_id = $1 
        WHERE id IN (SELECT richiesta_id FROM direttrici_richieste WHERE direttrice_id = $2)`, 
        [corsa.id, direttriceId]);
    
    console.log(`✅ [POPBUS] Corsa ID ${corsa.id} creata con successo.`);
    return corsa;
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
        const durataMin = Number(pending.durataMinuti ?? pending.durata_minuti ?? 30);
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

        let kmAvvicinamento = 0;
        let kmRiposizionamento = 0;

        try {
            const latBaseV = Number(veicolo?.lat_base ?? veicolo?.lat_deposito ?? coordOrig.lat);
            const lonBaseV = Number(veicolo?.lon_base ?? veicolo?.lon_deposito ?? coordOrig.lon);

            if (latBaseV && lonBaseV) {
                const routeAvv = await getRouteGeometry({ lat: latBaseV, lon: lonBaseV }, coordOrig);
                if (routeAvv?.distanzaKm) kmAvvicinamento = routeAvv.distanzaKm;

                const routeRip = await getRouteGeometry(coordDest, { lat: latBaseV, lon: lonBaseV });
                if (routeRip?.distanzaKm) kmRiposizionamento = routeRip.distanzaKm;
            }
            console.log(`📏 [MISSIONE FISSA STRADALE] Avvicinamento: ${kmAvvicinamento.toFixed(2)} km, Riposizionamento: ${kmRiposizionamento.toFixed(2)} km`);
        } catch (e) {
            console.warn(`⚠ [ROUTING WARNING] Errore calcolo avvicinamento/riposizionamento:`, e);
        }

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
            console.warn(`⚠ [ROUTE WARNING] Impossibile generare geometria per pending ${pending.id}:`, e);  
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
        console.log(`✅ [DB] Corsa ID ${corsa?.id} inserita correttamente.`);

        // --- GESTIONE E LOGGING DEGLI OFFSET E INDICI ---
        const distanzaMetriTotali = distanzaKm * 1000;
        const startOffsetVal = Number(pending.start_offset ?? pending.startOffset ?? 0);
        const endOffsetVal = Number(pending.end_offset ?? pending.endOffset ?? (distanzaMetriTotali > 0 ? distanzaMetriTotali : 1000));

        const startIdxVal = Number(pending.start_index_polyline ?? pending.startIndexPolyline ?? 0);
        const endIdxVal = Number(pending.end_index_polyline ?? pending.endIndexPolyline ?? 100);

        const segmenti = {  
            startIdx: startIdxVal,  
            endIdx: endIdxVal,
            startOffset: startOffsetVal,
            endOffset: endOffsetVal,
            latSalita: coordOrig.lat,   
            lonSalita: coordOrig.lon,   
            latDiscesa: coordDest.lat,  
            lonDiscesa: coordDest.lon   
        };

        const prenotazione = await prenotazioneService.prenotaCorsa(
            corsa, 
            pending.cliente_id ?? pending.clienteId, 
            Number(pending.posti_richiesti ?? 1), 
            segmenti, 
            client
        );
        
        console.log(`✅ [DB] Prenotazione ID ${prenotazione?.id} creata con successo per la corsa ${corsa.id}.`);
        await client.query(`UPDATE pagamenti SET corsa_id = $1 WHERE prenotazione_id = $2`, [corsa.id, prenotazione.id]);
    }

    CacheManager.corsa.update(corsa);
    upsertCorsa(corsa);

    if (localClient) await client.query('COMMIT');
    return { corsa };

  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    console.error(`❌ [ERROR] Fallimento in createCorsaFromPending per pending ID ${pending?.id}:`, err);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}