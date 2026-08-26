import { pool } from '../../db/db.js';
import * as prenotazioneService from '../prenotazione/prenotazione.service.js';
import { CacheManager } from '../../utils/cacheManager.js';
import { getRouteGeometry } from '../../utils/maps.util.js'; 
import polyline from 'polyline';
import ngeohash from 'ngeohash';
import { upsertCorsa } from '../search/search.cache.js'; 

// --- FUNZIONE DI SUPPORTO PER POPBUS ---
export async function createCorsaFromDirettrice(direttriceId, autistaId, client) {
    console.log(`🚌 [POPBUS] Creazione corsa da direttrice ID: ${direttriceId}`);
    const dirRes = await client.query(`
        SELECT d.*, v.posti_totali 
        FROM direttrici_virtuali d
        JOIN veicolo v ON v.id = d.veicolo_id 
        WHERE d.id = $1`, [direttriceId]);
    
    const d = dirRes.rows[0];
    
    const res = await client.query(`
        INSERT INTO corse (
            direttrice_id, autistaId, tipo_corsa, stato, start_datetime, posti_totali, posti_disponibili,
            origine, destinazione
        ) VALUES ($1, $2, 'popbus', 'confermata', $3, $4, $4, 
                ST_SetSRID(ST_MakePoint($5,$6),4326), 
                ST_SetSRID(ST_MakePoint($7,$8),4326))
        RETURNING *`, 
        [direttriceId, autistaId, d.partenza_prevista, d.posti_totali, 
         d.origine_lon, d.origine_lat, d.destinazione_lon, d.destinazione_lat]
    );

    const corsa = res.rows[0];
    
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

        // Controllo di sicurezza: impedisce coordinate a 0,0 (es. in mezzo all'oceano)
        if (coordOrig.lat === 0 || coordOrig.lon === 0 || coordDest.lat === 0 || coordDest.lon === 0) {
            console.error(`❌ [CREATE CORSA ERRORE] Coordinate non valide per il pending ${pending.id}: Origine(${coordOrig.lat}, ${coordOrig.lon}), Destinazione(${coordDest.lat}, ${coordDest.lon})`);
            throw new Error(`Coordinate di origine o destinazione non valide per il pending ${pending.id}`);
        }

        let polylineString = '';
        let pathGeohashes = [];
        try {
            console.log(`🗺️ [ROUTE] Richiesta geometria rotta per pending ${pending.id}...`);
            const routeData = await getRouteGeometry(coordOrig, coordDest); 
            polylineString = routeData.polyline;
            const coords = polyline.decode(polylineString);
            const step = Math.max(1, Math.floor(coords.length / 10));
            pathGeohashes = coords.filter((_, index) => index % step === 0).map(c => ngeohash.encode(c[0], c[1], 5));
            console.log(`✅ [ROUTE] Geometria generata con successo. Lunghezza polyline: ${polylineString.length} caratteri`);
        } catch (e) { 
            console.warn(`⚠️ [ROUTE WARNING] Impossibile generare la geometria per il pending ${pending.id}:`, e); 
        }

        const postiTotaliVeicolo = Number(veicolo?.posti_totali) || 4;

        // Inserimento con posti_totali e posti_disponibili inizializzati correttamente
        const res = await client.query(
          `INSERT INTO corse (
              veicolo_id, start_datetime, arrivo_datetime, tipo_corsa, stato, durata, 
              posti_totali, posti_disponibili, distanza, origine, destinazione, 
              origine_address, destinazione_address, percorso_polyline, path_geohashes, created_at
           )
           VALUES (
              $1, $2, $3, $4, 'prenotabile', $5, 
              $6, $6, $7, ST_SetSRID(ST_MakePoint($9,$8),4326), ST_SetSRID(ST_MakePoint($11,$10),4326), 
              $12, $13, $14, $15, NOW()
           ) RETURNING *`,
          [
            veicolo.id,                                      // $1
            startDatetime,                                   // $2
            arrivoDatetime,                                  // $3
            (pending.tipo_corsa === 'privata' ? 'privata' : 'condivisa'), // $4
            `${durataMin} minutes`,                          // $5
            postiTotaliVeicolo,                              // $6 (valore usato sia per posti_totali che posti_disponibili)
            (pending.distanza ?? 0),                         // $7
            coordOrig.lat,                                   // $8  (latitudine origine)
            coordOrig.lon,                                   // $9  (longitudine origine)
            coordDest.lat,                                   // $10 (latitudine destinazione)
            coordDest.lon,                                   // $11 (longitudine destinazione)
            (pending.origine_address ?? 'N/D'),              // $12
            (pending.destinazione_address ?? 'N/D'),         // $13
            polylineString,                                  // $14
            pathGeohashes                                    // $15
          ]
        );
        corsa = res.rows[0];
        console.log(`✅ [DB] Corsa ID ${corsa?.id} inserita correttamente nel database.`);

        const segmenti = { startIdx: pending.start_index_polyline ?? 0, endIdx: pending.end_index_polyline ?? 100 };
        const prenotazione = await prenotazioneService.prenotaCorsa(corsa, pending.cliente_id ?? pending.clienteId, Number(pending.posti_richiesti ?? 1), segmenti, client);
        
        await client.query(`UPDATE pagamenti SET corsa_id = $1 WHERE prenotazione_id = $2`, [corsa.id, prenotazione.id]);
    }

    // --- AGGIORNAMENTO CACHE ---
    CacheManager.corsa.update(corsa);
    upsertCorsa(corsa);

    if (localClient) await client.query('COMMIT');
    return { corsa };

  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    console.error(`❌ [ERROR] Fallimento in createCorsaFromPending:`, err);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}