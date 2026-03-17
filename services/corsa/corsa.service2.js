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

    // ========================
    // DATI BASE
    // ========================
    const startDatetime = new Date(pending.start_datetime);
    if (isNaN(startDatetime.getTime())) throw new Error("start_datetime non valido");

    const durataMin = pending.durata_minuti || pending.durata || 30;
    const arrivoDatetime = new Date(startDatetime.getTime() + durataMin * 60 * 1000);

    const postiTotali = pending.posti_totali || veicolo.posti || 4;
    const postiDisponibili = Math.max(postiTotali - (pending.posti_richiesti || 0), 0);

    const coordOrig = pending.coord_origine || { lat: 45.4642, lon: 9.19 };
    const coordDest = pending.coord_destinazione || { lat: 45.4781, lon: 9.227 };

    // ========================
    // TIPO CORSA VALIDO
    // ========================
    const tipoCorsa = pending.tipo_corsa === 'privata' ? 'privata' : 'condivisa';

    console.log('DEBUG createCorsaFromPending valori per INSERT:', {
      veicolo_id: veicolo.id,
      startDatetime,
      arrivoDatetime,
      tipoCorsa,
      durata: `${durataMin} minutes`,
      postiDisponibili,
      postiTotali,
      prezzo_fisso: pending.prezzo || 0,
      coordOrig,
      coordDest
    });

    // ========================
    // CREAZIONE CORSA
    // ========================
    const res = await client.query(
      `INSERT INTO corse (
          veicolo_id, start_datetime, arrivo_datetime, tipo_corsa, stato,
          durata, posti_disponibili, posti_totali, primo_posto, prezzo_fisso,
          origine, destinazione, created_at
       ) VALUES (
          $1,$2,$3,$4,'prenotabile',
          $5,$6,$7,0,$8,
          ST_SetSRID(ST_MakePoint($9,$10),4326),
          ST_SetSRID(ST_MakePoint($11,$12),4326),
          NOW()
       ) RETURNING *`,
      [
        veicolo.id,
        startDatetime,
        arrivoDatetime,
        tipoCorsa,
        `${durataMin} minutes`,
        postiDisponibili,
        postiTotali,
        pending.prezzo || 0,
        coordOrig.lon,
        coordOrig.lat,
        coordDest.lon,
        coordDest.lat
      ]
    );

    const corsa = res.rows[0];
    console.log('DEBUG corsa creata:', corsa);

    if (!corsa || !corsa.id) {
      throw new Error("DEBUG: insert corse non ha restituito id");
    }

    // ========================
    // PRENOTAZIONE AUTOMATICA
    // ========================
    const prenotazione = await prenotazioneService.prenotaCorsa(
      corsa,
      pending.cliente_id,
      pending.posti_richiesti || 1,
      client
    );

    // ========================
    // POSIZIONE PREDITTIVA
    // ========================
    if (corsa.destinazione && corsa.arrivo_datetime) {
      const tempoX = params.tempoPosizioneX || 2 * 60 * 60 * 1000;
      await aggiornaPosizionePredittiva(
        veicolo.id,
        { lat: coordDest.lat, lon: coordDest.lon },
        corsa.arrivo_datetime,
        tempoX,
        client
      );
    }

    if (localClient) await client.query('COMMIT');

    return { corsa, prenotazione };

  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    console.error('Errore createCorsaFromPending:', err.message, err.stack);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}
