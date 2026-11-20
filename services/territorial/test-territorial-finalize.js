
import { randomUUID } from 'node:crypto';
import { pool } from '../../db/db.js';
import { finalizzaVerifica } from './territorial-batch-finalize.service.js';

const client = await pool.connect();
const workerId = `territorial-finalize-test-${randomUUID()}`;
let transazioneAperta = false;

try {
  await client.query('BEGIN');
  transazioneAperta = true;

  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '15s'");

  const { rows } = await client.query(`
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

  if (rows.length !== 1) {
    throw new Error('Nessuna verifica disponibile');
  }

  const id = rows[0].id;
  console.log('Verifica acquisita:', id);

  // Un worker estraneo non deve poter finalizzare.
  let rifiutoConfermato = false;

  try {
    await finalizzaVerifica({
      id,
      workerId: 'worker-estraneo',
      esito: 'raggiungibile',
      client,
      simulazione: true
    });
  } catch (error) {
    if (!error.message.startsWith('Finalizzazione rifiutata:')) {
      throw error;
    }
    rifiutoConfermato = true;
    console.log('Worker estraneo correttamente rifiutato');
  }

  if (!rifiutoConfermato) {
    throw new Error('Un worker estraneo ha finalizzato la verifica');
  }

  // Il proprietario valido può finalizzare.
  const risultato = await finalizzaVerifica({
    id,
    workerId,
    esito: 'raggiungibile',
    client,
    simulazione: true
  });

  console.log('Finalizzazione simulata:', risultato);

  if (risultato.stato !== 'completata') {
    throw new Error('Stato finale non corretto');
  }

  await client.query('ROLLBACK');
  transazioneAperta = false;

  console.log('\nTEST FINALIZZAZIONE SUPERATO');
  console.log('ROLLBACK eseguito');
  console.log('Google: 0 chiamate');
  console.log('Modifiche permanenti: 0');

} catch (error) {
  console.error('TEST FALLITO:', error.message);
  process.exitCode = 1;

  if (transazioneAperta) {
    try {
      await client.query('ROLLBACK');
      transazioneAperta = false;
    } catch (rollbackError) {
      console.error('Errore ROLLBACK:', rollbackError.message);
    }
  }
} finally {
  client.release();
  await pool.end();
}
