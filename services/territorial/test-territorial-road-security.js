
import { randomUUID } from 'node:crypto';
import { pool } from '../../db/db.js';
import {
  finalizzaRisultatoStradale
} from './territorial-road-results.service.js';

const client = await pool.connect();
const workerId = `territorial-security-${randomUUID()}`;

let transazioneAperta = false;

const risultato = {
  stato: 'raggiungibile',
  distanza_m: 2400,
  durata_s: 360
};

async function verificaRifiuto(nome, id, worker, clientUsato) {
  let rifiutato = false;

  try {
    await finalizzaRisultatoStradale({
      client: clientUsato,
      id,
      workerId: worker,
      risultato,
      simulazione: true
    });
  } catch (error) {
    rifiutato = true;
    console.log(`OK - ${nome}: ${error.message}`);
  }

  if (!rifiutato) {
    throw new Error(`${nome}: operazione accettata indebitamente`);
  }
}

try {
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
  console.log('Verifica acquisita:', riga.id);

  // TEST 1: worker estraneo.
  await verificaRifiuto(
    'Worker non proprietario',
    riga.id,
    'worker-estraneo',
    client
  );

  // TEST 2: lease scaduta.
  await client.query(`
    UPDATE territorial_hub_coda_stradale
    SET lease_expires_at = NOW() - INTERVAL '1 minute'
    WHERE id = $1
  `, [riga.id]);

  await verificaRifiuto(
    'Lease scaduta',
    riga.id,
    workerId,
    client
  );

  // Ripristina la lease per il test successivo.
  await client.query(`
    UPDATE territorial_hub_coda_stradale
    SET lease_expires_at = NOW() + INTERVAL '2 minutes'
    WHERE id = $1
  `, [riga.id]);

  // TEST 3: errore SQL simulato.
  // SAVEPOINT permette di recuperare la transazione.
  await client.query('SAVEPOINT test_errore_sql');

  let erroreSqlRilevato = false;

  try {
    // Client delegato: intercetta soltanto la INSERT
    // nella matrice e provoca un errore SQL reale.
    const clientConErrore = {
      query: async (sql, params) => {
        if (
          typeof sql === 'string' &&
          sql.includes('INSERT INTO territorial_hub_matrice_stradale')
        ) {
          return client.query(
            'SELECT * FROM tabella_territoriale_test_inesistente'
          );
        }

        return client.query(sql, params);
      }
    };

    await finalizzaRisultatoStradale({
      client: clientConErrore,
      id: riga.id,
      workerId,
      risultato,
      simulazione: true
    });

  } catch (error) {
    if (error.code !== '42P01') {
      throw error;
    }

    erroreSqlRilevato = true;
    console.log('OK - Errore SQL intercettato:', error.code);

    await client.query('ROLLBACK TO SAVEPOINT test_errore_sql');
  }

  if (!erroreSqlRilevato) {
    throw new Error('Errore SQL non rilevato');
  }

  const verifica = await client.query(`
    SELECT
      q.stato AS stato_coda,
      m.id AS matrice_id
    FROM territorial_hub_coda_stradale q
    LEFT JOIN territorial_hub_matrice_stradale m
      ON m.centro_gid = q.centro_gid
     AND m.hub_id = q.hub_id
    WHERE q.id = $1
  `, [riga.id]);

  if (
    verifica.rows.length !== 1 ||
    verifica.rows[0].stato_coda !== 'in_elaborazione' ||
    verifica.rows[0].matrice_id !== null
  ) {
    throw new Error('Incoerenza dopo errore SQL');
  }

  console.log('OK - Nessuna scrittura nella matrice');
  console.log('OK - Coda non finalizzata');

  await client.query('ROLLBACK');
  transazioneAperta = false;

  console.log('\nTEST SICUREZZA SUPERATO');
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
