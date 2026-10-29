/** TURENTU STEP 4.32 — Test integrato A/R con ROLLBACK. */
import { randomUUID } from 'node:crypto';
import { pool } from '../db/db.js';
import {
  registraAccettazioneProvvisoriaAR,
  verificaCoppiaAR
} from '../services/booking/ar-acceptance.service.js';
import {
  verificaGruppoARTransazionale
} from '../services/booking/ar-transaction.service.js';

let client;
let superati = 0;
let rollbackOk = false;
const gruppoId = randomUUID();

function assert(condizione, messaggio) {
  if (!condizione) throw new Error(messaggio);
}

try {
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '2000ms'");
  await client.query("SET LOCAL statement_timeout = '10000ms'");

  const { rows: veicoli } = await client.query('SELECT id FROM veicolo ORDER BY id LIMIT 1');
  const { rows: utenti } = await client.query('SELECT id FROM utente ORDER BY id LIMIT 1');
  assert(veicoli.length && utenti.length, 'VEHICLE_OR_USER_MISSING');
  const veicoloId = veicoli[0].id;
  const clienteId = utenti[0].id;

  await client.query(`
    INSERT INTO ar_gruppi (id, cliente_id, stato, expires_at)
    VALUES ($1, $2, 'in_attesa', NOW() + INTERVAL '30 minutes')
  `, [gruppoId, clienteId]);

  async function creaPending(tratta, giorno, ora) {
    const { rows } = await client.query(`
      INSERT INTO pending (
        veicolo_id, cliente_id, start_datetime, durata,
        posti_richiesti, tipo_corsa, expires_at, stato,
        ar_group_id, ar_tratta, ar_vincolata,
        origine, destinazione
      ) VALUES (
        $1, $2,
        date_trunc('day', NOW()) + ($3::integer * INTERVAL '1 day') + ($4::integer * INTERVAL '1 hour'),
        INTERVAL '60 minutes', 1, 'privata',
        NOW() + INTERVAL '30 minutes', 'pending', $5, $6, TRUE,
        ST_SetSRID(ST_MakePoint(18.174966, 40.3515255),4326)::geography,
        ST_SetSRID(ST_MakePoint(17.2348, 40.4674),4326)::geography
      ) RETURNING id
    `, [veicoloId, clienteId, giorno, ora, gruppoId, tratta]);
    return rows[0].id;
  }

  const andataId = await creaPending('andata', 2, 10);
  const ritornoId = await creaPending('ritorno', 3, 10);

  let coppia = await verificaCoppiaAR(client, gruppoId);
  assert(!coppia.completa, 'TEST_1_FAILED');
  superati++; console.log('PASS 1: nessuna accettazione');

  await registraAccettazioneProvvisoriaAR(client, {
    arGroupId: gruppoId, pendingId: andataId, veicoloId
  });
  coppia = await verificaCoppiaAR(client, gruppoId);
  assert(!coppia.completa, 'TEST_2_FAILED');
  superati++; console.log('PASS 2: solo andata');

  await registraAccettazioneProvvisoriaAR(client, {
    arGroupId: gruppoId, pendingId: ritornoId, veicoloId
  });
  coppia = await verificaCoppiaAR(client, gruppoId);
  assert(coppia.completa, 'TEST_3_FAILED');
  superati++; console.log('PASS 3: coppia completa');

  // Test 4: trasferimento fra tratte separato di un giorno.
  // Movement simulato: nessuna chiamata Google.
  const controllo = await verificaGruppoARTransazionale(gruppoId, {
    client, movement: async () => ({ metres: 1000, seconds: 600 })
  });
  assert(Array.isArray(controllo.verifiche) && controllo.verifiche.length === 2,
    'TEST_4_FAILED');
  assert(controllo.compatibilitaTratte?.compatibile === true,
    'TEST_4_COMPATIBILITY_FAILED');
  superati++; console.log('PASS 4: coordinatore e trasferimento compatibile');

  // Test 5: sposta il ritorno a 30 minuti dopo l'inizio dell'andata.
  await client.query(`
    UPDATE pending
    SET start_datetime = (SELECT start_datetime + INTERVAL '30 minutes' FROM pending WHERE id = $1)
    WHERE id = $2
  `, [andataId, ritornoId]);
  const conflitto = await verificaGruppoARTransazionale(gruppoId, {
    client, movement: async () => ({ metres: 0, seconds: 0 })
  });
  assert(conflitto.verificato === false &&
    conflitto.compatibilitaTratte?.motivo === 'AR_SOVRAPPOSIZIONE',
    'TEST_5_FAILED');
  superati++; console.log('PASS 5: sovrapposizione A/R rifiutata');

  // Test 6: intervallo non sovrapposto ma trasferimento troppo lento.
  await client.query(`
    UPDATE pending
    SET start_datetime = (SELECT start_datetime + INTERVAL '90 minutes' FROM pending WHERE id = $1)
    WHERE id = $2
  `, [andataId, ritornoId]);
  const impossibile = await verificaGruppoARTransazionale(gruppoId, {
    client, movement: async () => ({ metres: 50000, seconds: 3600 })
  });
  assert(impossibile.verificato === false &&
    impossibile.compatibilitaTratte?.motivo === 'AR_TRASFERIMENTO_IMPOSSIBILE',
    'TEST_6_FAILED');
  superati++; console.log('PASS 6: trasferimento impossibile rifiutato');
} catch (error) {
  console.error('TEST FALLITO:', error);
  process.exitCode = 1;
} finally {
  if (client) {
    try {
      await client.query('ROLLBACK');
      rollbackOk = true;
      console.log('ROLLBACK eseguito');
    } catch (error) {
      console.error('ROLLBACK FALLITO:', error);
      process.exitCode = 1;
    } finally {
      client.release();
    }
  }
  await pool.end();
}
console.log(`Risultato: ${superati}/6 test superati`);
if (superati !== 6 || !rollbackOk) process.exitCode = 1;
