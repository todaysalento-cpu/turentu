
import { pool } from '../../db/db.js';

import {
  finalizzaRisultatoStradale
} from './territorial-road-results.service.js';

/**
 * Gestore transazionale territoriale V1.
 *
 * SICUREZZA:
 * - Solo simulazione.
 * - Nessun COMMIT.
 * - ROLLBACK obbligatorio.
 * - Nessuna chiamata Google.
 * - Non modifica PIXEL/POPBUS V2.
 */
export async function eseguiTransazioneTerritoriale({
  id,
  workerId,
  risultato,
  simulazione = false,
  client: externalClient
}) {
  if (simulazione !== true) {
    throw new Error(
      'Operazione bloccata: consentita solo simulazione'
    );
  }

  if (externalClient) {
    throw new Error(
      'Client esterno non consentito nel gestore V1'
    );
  }

  const client = await pool.connect();
  let transazioneAperta = false;

  try {
    await client.query('BEGIN');
    transazioneAperta = true;

    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    const esito = await finalizzaRisultatoStradale({
      client,
      id,
      workerId,
      risultato,
      provider: 'simulazione',
      simulazione: true
    });

    const controllo = await client.query(`
      SELECT
        q.id,
        q.stato AS stato_coda,
        m.stato AS stato_matrice,
        m.durata_secondi,
        m.distanza_stradale_m
      FROM territorial_hub_coda_stradale q
      JOIN territorial_hub_matrice_stradale m
        ON m.centro_gid = q.centro_gid
       AND m.hub_id = q.hub_id
      WHERE q.id = $1
    `, [id]);

    if (
      controllo.rows.length !== 1 ||
      controllo.rows[0].stato_coda !== 'completata' ||
      controllo.rows[0].stato_matrice !== esito.stato ||
      controllo.rows[0].durata_secondi !== esito.durata_s ||
      controllo.rows[0].distanza_stradale_m !== esito.distanza_m
    ) {
      throw new Error(
        'Incoerenza tra coda e matrice stradale'
      );
    }

    const verifica = controllo.rows[0];

    await client.query('ROLLBACK');
    transazioneAperta = false;

    return {
      successo: true,
      simulazione: true,
      persistito: false,
      rollback: true,
      id: String(id),
      classificazione: esito,
      verifica
    };

  } catch (error) {
    if (transazioneAperta) {
      try {
        await client.query('ROLLBACK');
        transazioneAperta = false;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Errore transazionale e rollback non riuscito'
        );
      }
    }

    throw error;

  } finally {
    client.release(
      transazioneAperta
        ? new Error('Transazione non chiusa')
        : undefined
    );
  }
}
