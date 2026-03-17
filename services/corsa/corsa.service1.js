import { pool } from '../../db/db.js';
import * as prenotazioneService from '../prenotazione/prenotazione.service.js';
import { aggiornaPosizionePredittiva } from '../veicolo/veicolo.service.js'; 
import params from '../../config/params.js';

export async function createCorsaFromPending(pending, veicolo, client) {
  let localClient = false;
  if (!client) {
    client = await pool.connect();
    localClient = true;
  }

  try {
    if (localClient) await client.query('BEGIN');

    // Calcolo start/arrivo
    const startDatetime = new Date(pending.start_datetime);
    const durataMin = pending.durata_minuti || 30;
    const arrivoDatetime = new Date(startDatetime.getTime() + durataMin * 60 * 1000);

    // ========================
    // CREAZIONE CORSA
    // ========================
    const res = await client.query(
      `INSERT INTO corse (
        veicolo_id, start_datetime, arrivo_datetime, tipo_corsa, stato,
        durata, posti_disponibili, posti_totali, posti_prenotati, primo_posto, prezzo_fisso,
        origine, destinazione, created_at
      ) VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,0,0,$9,
        ST_SetSRID(ST_MakePoint($10,$11),4326),
        ST_SetSRID(ST_MakePoint($12,$13),4326),
        NOW()
      ) RETURNING *`,
      [
        pending.veicolo_id,
        startDatetime,
        arrivoDatetime,
        pending.tipo_corsa,
        'prenotabile',
        `${durataMin} minutes`,
        veicolo.posti_totali,
        veicolo.posti_totali,
        pending.prezzo || 0,
        pending.coord_origine?.lon ?? veicolo.coord.lon,
        pending.coord_origine?.lat ?? veicolo.coord.lat,
        pending.coord_destinazione?.lon ?? veicolo.coord.lon,
        pending.coord_destinazione?.lat ?? veicolo.coord.lat
      ]
    );

    const corsa = res.rows[0];

    // ========================
    // PRENOTAZIONE AUTOMATICA
    // ========================
    const prenotazione = await prenotazioneService.prenotaCorsa(
      corsa,
      pending.cliente_id,
      pending.posti_richiesti,
      client
    );

    // ========================
    // AGGIORNA POSTI PRENOTATI E PRIMO POSTO
    // ========================
    await client.query(
      `UPDATE corse
       SET posti_prenotati = posti_prenotati + $1,
           posti_disponibili = posti_totali - (posti_prenotati + $1),
           primo_posto = $1
       WHERE id = $2`,
      [pending.posti_richiesti, corsa.id]
    );

    // ========================
    // POSIZIONE PREDITTIVA
    // ========================
    if (corsa.destinazione && corsa.arrivo_datetime) {
      const tempoX = params.tempoPosizioneX || 2 * 60 * 60 * 1000;
      await aggiornaPosizionePredittiva(
        veicolo.id,
        {
          lat: pending.coord_destinazione?.lat ?? veicolo.coord.lat,
          lon: pending.coord_destinazione?.lon ?? veicolo.coord.lon
        },
        corsa.arrivo_datetime,
        tempoX,
        client
      );
    }

    if (localClient) await client.query('COMMIT');
    return { corsa, prenotazione };

  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    console.error('Errore createCorsaFromPending:', err.message);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}
