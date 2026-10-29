
import { randomUUID } from 'node:crypto';
import { pool } from '../db/db.js';
import {
  registraAccettazioneProvvisoriaAR
} from '../services/booking/ar-acceptance.service.js';

const gruppoId = randomUUID();
let client;
let testSuperato = false;

try {
  client = await pool.connect();
  await client.query('BEGIN');

  const { rows: veicoli } = await client.query(`
    SELECT id
    FROM veicolo
    ORDER BY id
    LIMIT 1
  `);

  const { rows: utenti } = await client.query(`
    SELECT id
    FROM utente
    ORDER BY id
    LIMIT 1
  `);

  if (!veicoli.length || !utenti.length) {
    throw new Error('Mancano veicoli o utenti per il test');
  }

  const veicoloId = veicoli[0].id;
  const clienteId = utenti[0].id;

  const gruppo = await client.query(`
    INSERT INTO ar_gruppi (
      id, cliente_id, stato, expires_at
    )
    VALUES (
      $1, $2, 'in_attesa',
      NOW() + INTERVAL '30 minutes'
    )
    RETURNING id
  `, [gruppoId, clienteId]);

  const pending = await client.query(`
    INSERT INTO pending (
      veicolo_id,
      cliente_id,
      start_datetime,
      durata,
      posti_richiesti,
      tipo_corsa,
      expires_at,
      stato,
      ar_group_id,
      ar_tratta,
      ar_vincolata
    )
    VALUES (
      $1,
      $2,
      NOW() + INTERVAL '2 days',
      INTERVAL '60 minutes',
      1,
      'privata',
      NOW() + INTERVAL '30 minutes',
      'pending',
      $3,
      'andata',
      TRUE
    )
    RETURNING id
  `, [veicoloId, clienteId, gruppoId]);

  const pendingId = pending.rows[0].id;

  const prima = await registraAccettazioneProvvisoriaAR(
    client,
    { arGroupId: gruppoId, pendingId, veicoloId }
  );

  if (!prima.creata) {
    throw new Error('Prima accettazione non creata');
  }

  console.log('PASS: accettazione provvisoria creata');

  const seconda = await registraAccettazioneProvvisoriaAR(
    client,
    { arGroupId: gruppoId, pendingId, veicoloId }
  );

  if (
    seconda.creata ||
    String(seconda.accettazione.id) !==
      String(prima.accettazione.id)
  ) {
    throw new Error('Idempotenza non rispettata');
  }

  console.log('PASS: accettazione idempotente');

  try {
    await registraAccettazioneProvvisoriaAR(
      client,
      {
        arGroupId: randomUUID(),
        pendingId,
        veicoloId
      }
    );

    throw new Error('Gruppo errato accettato');
  } catch (error) {
    if (error.message === 'AR_GROUP_NOT_FOUND') {
      console.log('PASS: gruppo inesistente rifiutato');
    } else {
      throw error;
    }
  }

  testSuperato = true;
} catch (error) {
  console.error('TEST FALLITO:', error);
} finally {
  if (client) {
    try {
      await client.query('ROLLBACK');
      console.log('ROLLBACK eseguito');
    } catch (error) {
      console.error('ROLLBACK FALLITO:', error);
      testSuperato = false;
    }
    client.release();
  }

  await pool.end();
}

console.log(
  testSuperato
    ? '\nRisultato: 3/3 verifiche superate'
    : '\nRisultato: TEST FALLITO'
);

if (!testSuperato) {
  process.exitCode = 1;
}
