import { pool } from '../../db/db.js';
import * as prenotazioneService from '../prenotazione/prenotazione.service.js';
import { CacheManager } from '../../utils/cacheManager.js';
import { getRouteGeometry } from '../../utils/maps.util.js'; 
import polyline from 'polyline';
import ngeohash from 'ngeohash';
import { upsertCorsa } from '../search/search.cache.js'; 

// --- FUNZIONE DI SUPPORTO PER POPBUS (ORA ESPORTATA) ---
export async function createCorsaFromDirettrice(direttriceId, autistaId, client) {
    const dirRes = await client.query(`
        SELECT d.*, v.posti_totali 
        FROM direttrici_virtuali d
        JOIN veicolo v ON v.id = d.veicolo_id 
        WHERE d.id = $1`, [direttriceId]);
    
    const d = dirRes.rows[0];
    
    const res = await client.query(`
        INSERT INTO corse (
            direttrice_id, autistaId, tipo_corsa, stato, start_datetime, posti_totali,
            origine, destinazione
        ) VALUES ($1, $2, 'popbus', 'confermata', $3, $4, 
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
    
    return corsa;
}

// --- FUNZIONE PRINCIPALE (Mantenuta intatta) ---
export async function createCorsaFromPending(pending, veicolo, client, isPopBus = false, autistaId = null) {
  let localClient = false;
  if (!client) {
    client = await pool.connect();
    localClient = true;
  }

  try {
    if (localClient) await client.query('BEGIN');

    let corsa;

    // --- LOGICA BIVIO: POPBUS O PRIVATE ---
    if (isPopBus) {
        corsa = await createCorsaFromDirettrice(pending.direttrice_id, autistaId, client);
    } else {
        // --- LOGICA PRIVATE ---
        const startDatetime = new Date(pending.start_datetime || pending.startDatetime);
        const durataMin = Number(pending.durataMinuti ?? pending.durata_minuti ?? 30);
        const arrivoDatetime = new Date(startDatetime.getTime() + durataMin * 60 * 1000);
        const coordOrig = pending.coordOrigine ?? { lat: pending.origine_lat ?? 0, lon: pending.origine_lon ?? 0 };
        const coordDest = pending.coordDestinazione ?? { lat: pending.destinazione_lat ?? 0, lon: pending.destinazione_lon ?? 0 };

        let polylineString = '';
        let pathGeohashes = [];
        try {
          const routeData = await getRouteGeometry(coordOrig, coordDest); 
          polylineString = routeData.polyline;
          const coords = polyline.decode(polylineString);
          const step = Math.max(1, Math.floor(coords.length / 10));
          pathGeohashes = coords.filter((_, index) => index % step === 0).map(c => ngeohash.encode(c[0], c[1], 5));
        } catch (e) { console.warn('Fallback: Geometria non generata', e); }

        const res = await client.query(
          `INSERT INTO corse (veicolo_id, start_datetime, arrivo_datetime, tipo_corsa, stato, durata, posti_totali, distanza, origine, destinazione, origine_address, destinazione_address, percorso_polyline, path_geohashes, created_at)
           VALUES ($1,$2,$3,$4,'prenotabile', $5,$6,$7, ST_SetSRID(ST_MakePoint($9,$8),4326), ST_SetSRID(ST_MakePoint($11,$10),4326), $12,$13, $14, $15, NOW()) RETURNING *`,
          [veicolo.id, startDatetime, arrivoDatetime, (pending.tipo_corsa === 'privata' ? 'privata' : 'condivisa'), 
           `${durataMin} minutes`, (pending.posti_totali ?? 4), (pending.distanza ?? 0), 
           coordOrig.lat, coordOrig.lon, coordDest.lat, coordDest.lon,
           (pending.origine_address ?? 'N/D'), (pending.destinazione_address ?? 'N/D'), polylineString, pathGeohashes]
        );
        corsa = res.rows[0];

        const segmenti = { startIdx: pending.start_index_polyline ?? 0, endIdx: pending.end_index_polyline ?? 100 };
        const prenotazione = await prenotazioneService.prenotaCorsa(corsa, pending.cliente_id ?? pending.clienteId, Number(pending.posti_richiesti ?? 1), segmenti, client);
        await client.query(`UPDATE pagamenti SET corsa_id = $1 WHERE prenotazione_id = $2`, [corsa.id, prenotazione.id]);
    }

    // --- AGGIORNAMENTO COMUNE ---
    CacheManager.corsa.update(corsa);
    upsertCorsa(corsa);

    if (localClient) await client.query('COMMIT');
    return { corsa };

  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (localClient) client.release();
  }
}