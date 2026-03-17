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
    const startDatetime = new Date(
      pending.start_datetime || pending.startDatetime
    );

    if (isNaN(startDatetime.getTime()))
      throw new Error("start_datetime non valido");

    // ========================
    // DURATA ROBUSTA
    // ========================
    let durataMin =
      pending.durataMinuti ??
      pending.durata_minuti ??
      pending.durata_min ??
      null;

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

    if (isNaN(durataMin) || durataMin <= 0)
      throw new Error("Durata non valida nel pending");

    const arrivoDatetime = new Date(
      startDatetime.getTime() + durataMin * 60 * 1000
    );

    const durataStr = `${durataMin} minutes`;

    // ========================
    // POSTI
    // ========================
    const postiTotali =
      pending.posti_totali ||
      pending.postiTotali ||
      veicolo.posti ||
      4;

    const postiRichiesti =
      pending.posti_richiesti ||
      pending.postiRichiesti ||
      1;

    const postiDisponibili = Math.max(
      postiTotali - postiRichiesti,
      0
    );

    // ========================
    // COORDINATE ROBUSTE
    // ========================
    const coordOrig =
      pending.coord_origine ||
      pending.coordOrigine ||
      { lat: 45.4642, lon: 9.19 };

    const coordDest =
      pending.coord_destinazione ||
      pending.coordDestinazione ||
      { lat: 45.4781, lon: 9.227 };

    // ========================
    // TIPO CORSA ROBUSTO
    // ========================
    const tipoCorsa =
      pending.tipo_corsa === 'privata' ||
      pending.tipoCorsa === 'privata'
        ? 'privata'
        : 'condivisa';

    // ========================
    // ADDRESS ROBUSTI 🔥
    // ========================
    const origine_address =
      pending.origine_address ||
      pending.localitaOrigine ||
      pending.origineAddress ||
      'N/D';

    const destinazione_address =
      pending.destinazione_address ||
      pending.localitaDestinazione ||
      pending.destinazioneAddress ||
      'N/D';

    // ========================
    // CREAZIONE CORSA
    // ========================
    const res = await client.query(
      `INSERT INTO corse (
          veicolo_id,
          start_datetime,
          arrivo_datetime,
          tipo_corsa,
          stato,
          durata,
          posti_disponibili,
          posti_totali,
          primo_posto,
          prezzo_fisso,
          origine,
          destinazione,
          origine_address,
          destinazione_address,
          created_at
       ) VALUES (
          $1,$2,$3,$4,'prenotabile',
          $5,$6,$7,0,$8,
          ST_SetSRID(ST_MakePoint($9,$10),4326),
          ST_SetSRID(ST_MakePoint($11,$12),4326),
          $13,$14,
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
        pending.prezzo || pending.prezzo_fisso || 0,
        coordOrig.lon,
        coordOrig.lat,
        coordDest.lon,
        coordDest.lat,
        origine_address,
        destinazione_address
      ]
    );

    const corsa = res.rows[0];

    if (!corsa?.id)
      throw new Error("Insert corsa non ha restituito id");

    // ========================
    // PRENOTAZIONE AUTOMATICA
    // ========================
    const prenotazione = await prenotazioneService.prenotaCorsa(
      corsa,
      pending.cliente_id || pending.clienteId,
      postiRichiesti,
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
    throw err;
  } finally {
    if (localClient) client.release();
  }
}