
import { randomUUID } from 'node:crypto';
import { pool } from '../../db/db.js';

import {
  eseguiTransazioneTerritoriale
} from './territorial-road-transaction.service.js';

const workerId = `territorial-cycle-test-${randomUUID()}`;
const client = await pool.connect();

let transazioneAperta = false;
let id = null;
let acquisizioneConfermata = false;
let rilascioConfermato = false;

try {
  console.log('=== TEST CICLO OPERATIVO ===');
  console.log('Worker:', workerId);

  // 1. Acquisizione
  await client.query('BEGIN');
  transazioneAperta = true;

  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '15s'");

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
        terminato_at = NULL,
        lease_expires_at = NOW() + INTERVAL '2 minutes',
        updated_at = NOW()
    FROM selezionata s
    WHERE q.id = s.id
    RETURNING q.id
  `, [workerId]);

  if (acquisizione.rows.length !== 1) {
    throw new Error('Nessuna verifica disponibile');
  }

  id = acquisizione.rows[0].id;

  await client.query('COMMIT');
  transazioneAperta = false;
  acquisizioneConfermata = true;

  console.log('OK - Acquisizione confermata:', id);

  // 2. Finalizzazione tramite seconda connessione.
  const risultato = await eseguiTransazioneTerritoriale({
    id,
    workerId,
    risultato: {
      stato: 'raggiungibile',
      distanza_m: 2400,
      durata_s: 360
    },
    simulazione: true
  });

  if (
    !risultato.successo ||
    !risultato.rollback ||
    risultato.persistito !== false ||
    risultato.classificazione.entro_15_minuti !== true
  ) {
    throw new Error('Finalizzazione simulata non valida');
  }

  console.log('OK - Finalizzazione simulata');
  console.log('OK - ROLLBACK finalizzazione');

  // 3. Verifica che il ROLLBACK abbia
  // mantenuto l'acquisizione originale.
  const controllo = await client.query(`
    SELECT stato, worker_id
    FROM territorial_hub_coda_stradale
    WHERE id = $1
  `, [id]);

  if (
    controllo.rows.length !== 1 ||
    controllo.rows[0].stato !== 'in_elaborazione' ||
    controllo.rows[0].worker_id !== workerId
  ) {
    throw new Error('Acquisizione non preservata');
  }

  console.log('OK - Acquisizione preservata');

} catch (error) {
  console.error('TEST FALLITO:', error.message);
  process.exitCode = 1;

} finally {
  // 4. Pulizia obbligatoria.
  if (transazioneAperta) {
    try {
      await client.query('ROLLBACK');
      transazioneAperta = false;
    } catch (error) {
      console.error('Errore ROLLBACK:', error.message);
      process.exitCode = 1;
    }
  }

  if (acquisizioneConfermata && id !== null) {
    try {
      // Il rilascio è consentito soltanto
      // al worker proprietario e se la
      // verifica è ancora in elaborazione.
      const rilascio = await client.query(`
        UPDATE territorial_hub_coda_stradale
        SET stato = 'in_attesa',
            worker_id = NULL,
            iniziato_at = NULL,
            terminato_at = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND worker_id = $2
          AND stato = 'in_elaborazione'
        RETURNING id
      `, [id, workerId]);

      if (rilascio.rowCount !== 1) {
        throw new Error(
          'Rilascio non confermato: verificare la coda'
        );
      }

      rilascioConfermato = true;
      console.log('OK - Verifica rilasciata:', id);

    } catch (error) {
      console.error('ERRORE PULIZIA:', error.message);
      process.exitCode = 1;
    }
  }

  client.release();

  if (rilascioConfermato) {
    try {
      const integrita = await pool.query(`
        SELECT
          (SELECT COUNT(*)
           FROM territorial_hub_coda_stradale
           WHERE scenario_km = 15
             AND stato = 'in_attesa') AS in_attesa,
          (SELECT COUNT(*)
           FROM territorial_hub_coda_stradale
           WHERE worker_id = $1) AS residue_worker,
          (SELECT COUNT(*)
           FROM territorial_hub_matrice_stradale) AS matrice
      `, [workerId]);

      console.log('\n=== INTEGRITA DATABASE ===');
      console.table(integrita.rows);

      if (
        Number(integrita.rows[0].residue_worker) !== 0 ||
        Number(integrita.rows[0].matrice) !== 0
      ) {
        throw new Error('Integrità finale non verificata');
      }

      if (Number(integrita.rows[0].in_attesa) !== 717) {
        console.warn(
          'ATTENZIONE: numero verifiche diverso da 717'
        );
      }

      if (process.exitCode !== 1) {
        console.log('\nTEST CICLO OPERATIVO SUPERATO');
        console.log('Google: 0 chiamate');
        console.log('Matrice: 0 scritture permanenti');
        console.log('Acquisizione: confermata e poi rilasciata');
      }

    } catch (error) {
      console.error('ERRORE VERIFICA:', error.message);
      process.exitCode = 1;
    }
  }

  await pool.end();
}
