
import { randomUUID } from 'node:crypto';
import { pool } from '../../db/db.js';
import {
  finalizzaRisultatoStradale
} from './territorial-road-results.service.js';

const client = await pool.connect();
const workerId = `territorial-road-test-${randomUUID()}`;
let aperta = false;

try {
  await client.query('BEGIN');
  aperta = true;

  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '15s'");

  const acquisizione = await client.query(`
    WITH selezionata AS (
      SELECT id
      FROM territorial_hub_coda_stradale
      WHERE stato = 'in_attesa'
        AND scenario_km = 15
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
    RETURNING q.id, q.centro_gid, q.hub_id
  `, [workerId]);

  if (acquisizione.rows.length !== 1) {
    throw new Error('Nessuna verifica disponibile');
  }

  const riga = acquisizione.rows[0];

  // Valori sintetici, non derivati da Google.
  const risultato = await finalizzaRisultatoStradale({
    client,
    id: riga.id,
    workerId,
    risultato: {
      stato: 'raggiungibile',
      distanza_m: 2400,
      durata_s: 360
    },
    simulazione: true
  });

  console.log('\n=== RISULTATO SIMULATO ===');
  console.log(risultato);

  const verifica = await client.query(`
    SELECT
      q.stato AS stato_coda,
      m.stato AS stato_matrice,
      m.durata_secondi,
      m.distanza_stradale_m
    FROM territorial_hub_coda_stradale q
    JOIN territorial_hub_matrice_stradale m
      ON m.centro_gid = q.centro_gid
     AND m.hub_id = q.hub_id
    WHERE q.id = $1
  `, [riga.id]);

  console.log('\n=== VERIFICA ATOMICA ===');
  console.table(verifica.rows);

  if (
    verifica.rows.length !== 1 ||
    verifica.rows[0].stato_coda !== 'completata' ||
    verifica.rows[0].stato_matrice !== 'raggiungibile' ||
    verifica.rows[0].durata_secondi !== 360 ||
    verifica.rows[0].distanza_stradale_m !== 2400 ||
    risultato.entro_15_minuti !== true
  ) {
    throw new Error('Verifica atomica non superata');
  }

  await client.query('ROLLBACK');
  aperta = false;

  console.log('\nTEST MATRICE SUPERATO');
  console.log('ROLLBACK eseguito');
  console.log('Google: 0 chiamate');
  console.log('Scritture permanenti: 0');

} catch (error) {
  console.error('TEST FALLITO:', error.message);
  process.exitCode = 1;

  if (aperta) {
    try {
      await client.query('ROLLBACK');
      aperta = false;
    } catch (e) {
      console.error('Errore ROLLBACK:', e.message);
    }
  }
} finally {
  client.release();
  await pool.end();
}
