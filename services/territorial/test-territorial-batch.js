
import { randomUUID } from 'node:crypto';
import { pool } from '../../db/db.js';

const LIMITE_BATCH = 5;
const workerId = `territorial-test-${randomUUID()}`;

const client = await pool.connect();
let transazioneAperta = false;

try {
  await client.query('BEGIN');
  transazioneAperta = true;

  // Impedisce che il test rimanga bloccato indefinitamente.
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '15s'");

  // Acquisizione concorrente sicura.
  const acquisizione = await client.query(
    `
    WITH selezionate AS (
      SELECT id
      FROM territorial_hub_coda_stradale
      WHERE scenario_km = $1
        AND stato = 'in_attesa'
      ORDER BY priorita, distanza_geografica_m, id
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    UPDATE territorial_hub_coda_stradale q
    SET stato = 'in_elaborazione',
        tentativi = tentativi + 1,
        iniziato_at = NOW(),
        terminato_at = NULL,
        worker_id = $3,
        updated_at = NOW(),
        ultimo_errore = NULL
    FROM selezionate s
    WHERE q.id = s.id
    RETURNING
      q.id,
      q.centro_gid,
      q.hub_id,
      q.distanza_geografica_m,
      q.priorita,
      q.stato,
      q.tentativi
    `,
    [15, LIMITE_BATCH, workerId]
  );

  console.log('\n=== ACQUISIZIONE BATCH ===');
  console.table(acquisizione.rows);

  // Simulazione senza Google e senza valori inventati.
  for (const riga of acquisizione.rows) {
    const completamento = await client.query(
      `
      UPDATE territorial_hub_coda_stradale
      SET stato = 'completata',
          terminato_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
        AND worker_id = $2
        AND stato = 'in_elaborazione'
      RETURNING id, stato, tentativi
      `,
      [riga.id, workerId]
    );

    if (completamento.rowCount !== 1) {
      throw new Error(`Completamento fallito: ${riga.id}`);
    }

    console.log(
      `SIMULAZIONE: ${riga.id} -> completata`
    );
  }

  const verifica = await client.query(
    `
    SELECT stato, COUNT(*)::integer AS totale
    FROM territorial_hub_coda_stradale
    WHERE worker_id = $1
    GROUP BY stato
    `,
    [workerId]
  );

  console.log('\n=== STATO NELLA TRANSAZIONE ===');
  console.table(verifica.rows);

  if (
    acquisizione.rows.length !== LIMITE_BATCH ||
    verifica.rows.length !== 1 ||
    verifica.rows[0].stato !== 'completata' ||
    verifica.rows[0].totale !== LIMITE_BATCH
  ) {
    throw new Error('Verifica batch non superata');
  }

  // Nessuna modifica permanente.
  await client.query('ROLLBACK');
  transazioneAperta = false;

  console.log('\n=== RISULTATO ===');
  console.log('TEST SUPERATO');
  console.log('Google: 0 chiamate');
  console.log('Database: ROLLBACK eseguito');
  console.log('Modifiche permanenti: 0');

} catch (error) {
  console.error('\nTEST FALLITO:', error.message);
  process.exitCode = 1;

  if (transazioneAperta) {
    try {
      await client.query('ROLLBACK');
      transazioneAperta = false;
    } catch (rollbackError) {
      console.error('ROLLBACK fallito:', rollbackError.message);
    }
  }
} finally {
  client.release();
  await pool.end();
}
