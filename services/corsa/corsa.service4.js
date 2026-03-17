import { pool } from '../../db/db.js';
import * as prenotazioneService from '../prenotazione/prenotazione.service.js';
import { aggiornaPosizionePredittiva } from '../veicolo/veicolo.service.js';
import params from '../../config/params.js';

/**
 * Crea una corsa partendo da un pending
 */
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
    console.log('🔹 [DEBUG] startDatetime:', startDatetime);
    if (isNaN(startDatetime.getTime())) throw new Error("start_datetime non valido");

    // ========================
    // DURATA CORRETTA
    // ========================
    let durataMin = pending.durataMinuti ?? pending.durata_minuti;

    if (durataMin == null) {
      if (pending.durata != null && typeof pending.durata === 'object') {
        // ✅ Correzione: calcola ore + minuti totali
        const hours = pending.durata.hours ?? 0;
        const minutes = pending.durata.minutes ?? 0;
        durataMin = hours * 60 + minutes;
        console.log('🔹 [DEBUG] durataMin calcolata da pending.durata object (ore+minuti):', durataMin);
      } else {
        durataMin = 30;
        console.log('🔹 [DEBUG] durataMin fallback 30 minuti');
      }
    } else {
      durataMin = Number(durataMin);
      console.log('🔹 [DEBUG] durataMin finale:', durataMin);
    }

    if (isNaN(durataMin) || durataMin <= 0) {
      throw new Error("Durata non valida nel pending: " + JSON.stringify(pending.durata));
    }

    const arrivoDatetime = new Date(startDatetime.getTime() + durataMin * 60 * 1000);
    const durataStr = `${durataMin} minutes`;
    console.log('🔹 [DEBUG] arrivoDatetime:', arrivoDatetime);
    console.log('🔹 [DEBUG] durataStr per INSERT:', durataStr);

    // ========================
    // POSTI
    // ========================
    const postiTotali = pending.posti_totali || veicolo.posti || 4;
    const postiDisponibili = Math.max(postiTotali - (pending.posti_richiesti || 0), 0);

    // ========================
    // COORDINATE
    // ========================
    const coordOrig = pending.coord_origine || { lat: 45.4642, lon: 9.19 };
    const coordDest = pending.coord_destinazione || { lat: 45.4781, lon: 9.227 };

    const tipoCorsa = pending.tipo_corsa === 'privata' ? 'privata' : 'condivisa';

    console.log('🔹 [DEBUG] createCorsaFromPending valori per INSERT:', {
      veicolo_id: veicolo.id,
      startDatetime,
      arrivoDatetime,
      tipoCorsa,
      durataStr,
      durataMin,
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
        durataStr,
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
    console.log('🔹 [DEBUG] corsa INSERT result:', corsa);
    if (!corsa || !corsa.id) throw new Error("DEBUG: insert corse non ha restituito id");

    // ========================
    // PRENOTAZIONE AUTOMATICA
    // ========================
    const prenotazione = await prenotazioneService.prenotaCorsa(
      corsa,
      pending.cliente_id,
      pending.posti_richiesti || 1,
      client
    );
    console.log('🔹 [DEBUG] prenotazione creata:', prenotazione);

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
      console.log('🔹 [DEBUG] posizione predittiva aggiornata');
    }

    if (localClient) await client.query('COMMIT');

    return { corsa, prenotazione };

  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    console.error('❌ Errore createCorsaFromPending:', err.message, err.stack);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}

/**
 * Ritorna tutte le corse della giornata odierna
 */
export async function getCorseOggi(client) {
  const localClient = client || await pool.connect();
  try {
    const oggi = new Date();
    oggi.setHours(0, 0, 0, 0);
    const domani = new Date(oggi.getTime() + 24 * 60 * 60 * 1000);

    const res = await localClient.query(
      `SELECT *, 
        ST_X(origine::geometry) AS origine_lon,
        ST_Y(origine::geometry) AS origine_lat,
        ST_X(destinazione::geometry) AS destinazione_lon,
        ST_Y(destinazione::geometry) AS destinazione_lat
       FROM corse
       WHERE start_datetime >= $1 AND start_datetime < $2
       ORDER BY start_datetime ASC`,
      [oggi, domani]
    );
    return res.rows;
  } finally {
    if (!client) localClient.release();
  }
}

/**
 * Ritorna corsa per ID
 */
export async function getCorsaById(id, client) {
  const localClient = client || await pool.connect();
  try {
    const res = await localClient.query(
      `SELECT *, 
        ST_X(origine::geometry) AS origine_lon,
        ST_Y(origine::geometry) AS origine_lat,
        ST_X(destinazione::geometry) AS destinazione_lon,
        ST_Y(destinazione::geometry) AS destinazione_lat
       FROM corse
       WHERE id=$1`,
      [id]
    );
    return res.rows[0];
  } finally {
    if (!client) localClient.release();
  }
}