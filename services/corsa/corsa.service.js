import { pool } from '../../db/db.js';
import * as prenotazioneService from '../prenotazione/prenotazione.service.js';
import { aggiornaPosizionePredittiva } from '../veicolo/veicolo.service.js';
import params from '../../config/params.js';
import { CacheManager } from '../../utils/cacheManager.js';
import { getDurataDistanza } from '../../utils/maps.util.js'; 

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

    // --- DURATA ---
    let durataMin = pending.durataMinuti ?? pending.durata_minuti ?? pending.durata_min ?? null;
    if (durataMin == null) {
      if (pending.durata && typeof pending.durata === 'object') {
        const hours = pending.durata.hours ?? 0;
        const minutes = pending.durata.minutes ?? 0;
        durataMin = hours * 60 + minutes;
      } else {
        durataMin = 30;
      }
    }
    durataMin = Number(durataMin);
    if (isNaN(durataMin) || durataMin <= 0) throw new Error('Durata non valida nel pending');

    const arrivoDatetime = new Date(startDatetime.getTime() + durataMin * 60 * 1000);

    // --- POSTI ---
    const postiTotali = pending.posti_totali ?? pending.postiTotali ?? veicolo.posti ?? 4;
    const postiRichiesti = Number(pending.posti_richiesti ?? pending.postiRichiesti ?? 1);
    const postiDisponibili = Math.max(postiTotali - postiRichiesti, 0);

    // --- COORDINATE ---
    const coordOrig = pending.coordOrigine ??
      (pending.origine ? { lat: pending.origine_lat ?? 0, lon: pending.origine_lon ?? 0 } : { lat: 0, lon: 0 });

    const coordDest = pending.coordDestinazione ??
      (pending.destinazione ? { lat: pending.destinazione_lat ?? 0, lon: pending.destinazione_lon ?? 0 } : { lat: 0, lon: 0 });

    const tipoCorsa = (pending.tipo_corsa === 'privata' || pending.tipoCorsa === 'privata') ? 'privata' : 'condivisa';
    const origine_address = pending.origine_address ?? pending.localitaOrigine ?? pending.origineAddress ?? 'N/D';
    const destinazione_address = pending.destinazione_address ?? pending.localitaDestinazione ?? pending.destinazioneAddress ?? 'N/D';

    // --- 🔥 DISTANZA ---
    let distanzaKm = Number(String(pending.distanza ?? 0).replace(',', '.').trim());
    if (isNaN(distanzaKm) || distanzaKm <= 0) {
      try {
        const geo = await getDurataDistanza({ lat: coordOrig.lat, lon: coordOrig.lon }, { lat: coordDest.lat, lon: coordDest.lon });
        distanzaKm = Number(geo.distanzaKm ?? 0);
      } catch (e) {
        distanzaKm = 0;
      }
    }

    // --- CREAZIONE CORSA (PULITA) ---
    // Rimosso primo_posto e posti_prenotati: la logica ora è gestita dinamicamente dal servizio prenotazioni
    const res = await client.query(
      `INSERT INTO corse (
          veicolo_id, start_datetime, arrivo_datetime, tipo_corsa, stato,
          durata, posti_disponibili, posti_totali, prezzo_fisso,
          distanza, origine, destinazione, origine_address, destinazione_address, created_at
       ) VALUES (
          $1,$2,$3,$4,'prenotabile',
          $5,$6,$7,$8,
          $9,
          ST_SetSRID(ST_MakePoint($10,$11),4326),
          ST_SetSRID(ST_MakePoint($12,$13),4326),
          $14,$15,NOW()
       ) RETURNING *`,
      [
        veicolo.id, startDatetime, arrivoDatetime, tipoCorsa, `${durataMin} minutes`,
        postiDisponibili, postiTotali, (pending.prezzo ?? pending.prezzo_fisso ?? 0),
        distanzaKm, coordOrig.lon, coordOrig.lat, coordDest.lon, coordDest.lat,
        origine_address, destinazione_address
      ]
    );

    const corsa = res.rows[0];
    if (!corsa?.id) throw new Error('Insert corsa non ha restituito id');

    // ✅ AGGIORNAMENTO CACHE
    CacheManager.corsa.update({ ...corsa, origine_lat: coordOrig.lat, origine_lon: coordOrig.lon, dest_lat: coordDest.lat, dest_lon: coordDest.lon });

    const dispRes = await client.query(`SELECT d.*, v.driver_id FROM disponibilita_veicolo d JOIN veicolo v ON v.id = d.veicolo_id WHERE d.veicolo_id = $1`, [veicolo.id]);
    if (dispRes.rows.length > 0) CacheManager.disponibilita.update(dispRes.rows[0]);

    // --- PRENOTAZIONE E PAGAMENTO ---
    // Il servizio prenotaCorsa ora popola solo 'prenotazioni' ed è l'unica fonte di verità
    const prenotazione = await prenotazioneService.prenotaCorsa(corsa, pending.cliente_id ?? pending.clienteId, postiRichiesti, client);
    await client.query(`UPDATE pagamenti SET corsa_id = $1 WHERE prenotazione_id = $2`, [corsa.id, prenotazione.id]);

    // --- POSIZIONE PREDITTIVA ---
    if (corsa.destinazione && corsa.arrivo_datetime) {
      await aggiornaPosizionePredittiva(veicolo.id, { lat: coordDest.lat, lon: coordDest.lon }, corsa.arrivo_datetime, params.tempoPosizioneX ?? 7200000, client);
    }

    if (localClient) await client.query('COMMIT');
    return { corsa, prenotazione };

  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (localClient) client.release();
  }
}