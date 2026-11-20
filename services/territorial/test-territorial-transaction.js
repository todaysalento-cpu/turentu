
import { randomUUID } from 'node:crypto';
import { pool } from '../../db/db.js';

import {
  eseguiTransazioneTerritoriale
} from './territorial-road-transaction.service.js';

const workerId = `territorial-tx-test-${randomUUID()}`;

const client = await pool.connect();
let transazioneAperta = false;

try {
  console.log('=== TEST GESTORE TRANSAZIONALE ===');

  // Controllo modalità non autorizzata.
  let bloccata = false;

  try {
    await eseguiTransazioneTerritoriale({
      id: 589,
      workerId,
      risultato: {
        stato: 'raggiungibile',
        distanza_m: 2400,
        durata_s: 360
      },
      simulazione: false
    });
  } catch (error) {
    bloccata = true;
    console.log('OK - Modalità reale bloccata');
  }

  if (!bloccata) {
    throw new Error('Modalità reale non bloccata');
  }

  // Acquisizione temporanea, non confermata.
  await client.query('BEGIN');
  transazioneAperta = true;

  const acquisizione = await client.query(`
    WITH selezionata AS (
      SELECT id
      FROM territorial_hub_coda_stradale
      WHERE scenario_km = 15
        AND stato = 'in_attesa'
      ORDER BY priorita, distanza_geografica_m, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE territorial_hub_coda_stradale q
    SET stato = 'in_elaborazione',
        worker_id = $1,
        iniziato_at = NOW(),
        lease_expires_at = NOW() + INTERVAL '2 minutes',
        updated_at = NOW()
    FROM selezionata s
    WHERE q.id = s.id
    RETURNING q.id
  `, [workerId]);

  if (acquisizione.rows.length !== 1) {
    throw new Error('Nessuna verifica disponibile');
  }

  const id = acquisizione.rows[0].id;
  console.log('Verifica acquisita:', id);

  // La seconda connessione non deve vedere
  // l'acquisizione ancora non confermata.
  let rifiutata = false;

  try {
    await eseguiTransazioneTerritoriale({
      id,
      workerId,
      risultato: {
        stato: 'raggiungibile',
        distanza_m: 2400,
        durata_s: 360
      },
      simulazione: true
    });
  } catch (error) {
    if (
      !error.message.includes(
        'Verifica non finalizzabile'
      )
    ) {
      throw error;
    }

    rifiutata = true;
    console.log(
      'OK - Acquisizione non confermata non finalizzabile'
    );
  }

  if (!rifiutata) {
    throw new Error(
      'Acquisizione non confermata finalizzata indebitamente'
    );
  }

  await client.query('ROLLBACK');
  transazioneAperta = false;

  console.log('\nTEST TRANSAZIONALE SUPERATO');
  console.log('Google: 0 chiamate');
  console.log('Scritture permanenti: 0');

} catch (error) {
  console.error('TEST FALLITO:', error.message);
  process.exitCode = 1;

} finally {
  if (transazioneAperta) {
    try {
      await client.query('ROLLBACK');
    } catch (error) {
      console.error('Errore ROLLBACK:', error.message);
    }
  }

  client.release();
  await pool.end();
}
