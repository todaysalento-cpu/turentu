import { pool } from '../../db/db.js';
import * as prenotazioneService from '../prenotazione/prenotazione.service.js';
import { aggiornaPosizionePredittiva } from '../veicolo/veicolo.service.js';
import params from '../../config/params.js';
import { CacheManager } from '../../utils/cacheManager.js';
import { getRouteGeometry } from '../../utils/maps.util.js'; 
import polyline from 'polyline';
import ngeohash from 'ngeohash';
// Import necessario per sincronizzare il motore di ricerca
import { upsertCorsa } from '../search/search.cache.js'; 

export async function createCorsaFromPending(pending, veicolo, client) {
  let localClient = false;
  if (!client) {
    client = await pool.connect();
    localClient = true;
  }

  try {
    if (localClient) await client.query('BEGIN');

    // --- DATI BASE ---
    const startDatetime = new Date(pending.start_datetime || pending.startDatetime);
    if (isNaN(startDatetime.getTime())) throw new Error('start_datetime non valido');

    const durataMin = Number(pending.durataMinuti ?? pending.durata_minuti ?? 30);
    const arrivoDatetime = new Date(startDatetime.getTime() + durataMin * 60 * 1000);
    const postiTotali = pending.posti_totali ?? pending.postiTotali ?? veicolo.posti ?? 4;
    const postiRichiesti = Number(pending.posti_richiesti ?? pending.postiRichiesti ?? 1);

    const coordOrig = pending.coordOrigine ?? { lat: pending.origine_lat ?? 0, lon: pending.origine_lon ?? 0 };
    const coordDest = pending.coordDestinazione ?? { lat: pending.destinazione_lat ?? 0, lon: pending.destinazione_lon ?? 0 };

    // --- GEOMETRIA PER RIDESHARING DINAMICO ---
    let polylineString = '';
    let pathGeohashes = [];
    try {
      const routeData = await getRouteGeometry(coordOrig, coordDest); 
      polylineString = routeData.polyline;
      
      const coords = polyline.decode(polylineString);
      
      const step = Math.max(1, Math.floor(coords.length / 10));
      pathGeohashes = coords
        .filter((_, index) => index % step === 0)
        .map(c => ngeohash.encode(c[0], c[1], 5));
        
    } catch (e) {
      console.warn('Fallback: Impossibile generare geometria percorso', e);
    }

    // --- CREAZIONE CORSA ---
    const res = await client.query(
      `INSERT INTO corse (
          veicolo_id, start_datetime, arrivo_datetime, tipo_corsa, stato,
          durata, posti_totali, distanza, 
          origine, destinazione, origine_address, destinazione_address,
          percorso_polyline, path_geohashes, created_at
       ) VALUES (
          $1,$2,$3,$4,'prenotabile', $5,$6,$7,
          ST_SetSRID(ST_MakePoint($9,$8),4326),
          ST_SetSRID(ST_MakePoint($11,$10),4326),
          $12,$13, $14, $15, NOW()
       ) RETURNING *`,
      [
        veicolo.id, startDatetime, arrivoDatetime, 
        (pending.tipo_corsa === 'privata' ? 'privata' : 'condivisa'), 
        `${durataMin} minutes`, postiTotali, 
        (pending.distanza ?? 0), 
        coordOrig.lat, coordOrig.lon, // $8, $9
        coordDest.lat, coordDest.lon, // $10, $11
        (pending.origine_address ?? 'N/D'), (pending.destinazione_address ?? 'N/D'),
        polylineString, pathGeohashes
      ]
    );

    const corsa = res.rows[0];
    
    // --- PRENOTAZIONE E CACHE ---
    const prenotazione = await prenotazioneService.prenotaCorsa(corsa, pending.cliente_id ?? pending.clienteId, postiRichiesti, client);
    await client.query(`UPDATE pagamenti SET corsa_id = $1 WHERE prenotazione_id = $2`, [corsa.id, prenotazione.id]);

    // Aggiornamento CacheManager (Stato)
    CacheManager.corsa.update(corsa);
    
    // Sincronizzazione Motore di Ricerca (Filtri/Geohash)
    upsertCorsa(corsa);

    if (localClient) await client.query('COMMIT');
    
    return { corsa, prenotazione };

  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (localClient) client.release();
  }
}