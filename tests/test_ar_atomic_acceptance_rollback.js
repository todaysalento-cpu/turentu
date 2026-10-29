/** TURENTU STEP 4.34 — Test atomico A/R, SOLO ROLLBACK.
 * Eseguire esclusivamente su DB di collaudo: blocca temporaneamente righe
 * veicolo/disponibilita e crea dati transitori fino al ROLLBACK.
 * Non richiama Stripe e non abilita endpoint LIVE.
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../db/db.js';
import { accettaTrattaARAtomica } from '../services/booking/ar-atomic-acceptance.service.js';
import { registraAccettazioneProvvisoriaAR } from '../services/booking/ar-acceptance.service.js';

let client;
let passed = 0;
let failed = false;
const createdIds = [];
const movementOk = async () => ({ metres: 100, seconds: 60 });
const movementSlow = async () => ({ metres: 50000, seconds: 3600 });
function assert(value, msg) { if (!value) throw new Error(msg); }
async function expectedFailure(label, code, action) {
  await client.query('SAVEPOINT test_case');
  let error;
  try { await action(); } catch (e) { error = e; }
  await client.query('ROLLBACK TO SAVEPOINT test_case');
  await client.query('RELEASE SAVEPOINT test_case');
  assert(error && (error.code === code || error.message === code),
    `${label}: atteso ${code}, ricevuto ${error?.code ?? error?.message ?? 'SUCCESS'}`);
  passed++; console.log(`PASS ${passed}: ${label}`);
}
async function success(label, action) {
  await client.query('SAVEPOINT test_case');
  try { await action(); } finally {
    await client.query('ROLLBACK TO SAVEPOINT test_case');
    await client.query('RELEASE SAVEPOINT test_case');
  }
  passed++; console.log(`PASS ${passed}: ${label}`);
}

try {
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '2000ms'");
  await client.query("SET LOCAL statement_timeout = '15000ms'");

  // Usa un veicolo esistente con operatore associato. Nessuna modifica permanente.
  const { rows: vehicles } = await client.query(`
    SELECT v.id, v.driver_id
    FROM veicolo v
    WHERE v.driver_id IS NOT NULL
      AND (v.stato IS NULL OR v.stato IN ('test','attivo'))
    ORDER BY v.id LIMIT 1
  `);
  const { rows: users } = await client.query('SELECT id FROM utente ORDER BY id LIMIT 1');
  assert(vehicles.length && users.length, 'Mancano veicolo con driver_id o cliente');
  const vehicleId = vehicles[0].id;
  const operatorId = vehicles[0].driver_id;
  const clientId = users[0].id;

  // Ora di prova in futuro lontano, per minimizzare conflitti con corse reali.
  // 2032-01-14 10:00 UTC = 11:00 Europe/Rome.
  const startIso = '2032-01-14T10:00:00Z';
  async function createGroup() {
    const id = randomUUID();
    await client.query(`INSERT INTO ar_gruppi(id, cliente_id, stato, expires_at)
      VALUES($1,$2,'in_attesa',NOW()+INTERVAL '30 minutes')`, [id, clientId]);
    return id;
  }
  async function createPending(groupId, start = startIso, leg = 'andata') {
    const { rows } = await client.query(`
      INSERT INTO pending (
        veicolo_id, cliente_id, start_datetime, durata,
        posti_richiesti, tipo_corsa, expires_at, stato,
        ar_group_id, ar_tratta, ar_vincolata, origine, destinazione
      ) VALUES (
        $1,$2,$3::timestamptz,INTERVAL '60 minutes',1,'privata',
        NOW()+INTERVAL '30 minutes','pending',$4,$5,TRUE,
        ST_SetSRID(ST_MakePoint(18.174966,40.3515255),4326)::geography,
        ST_SetSRID(ST_MakePoint(17.2348,40.4674),4326)::geography
      ) RETURNING id`, [vehicleId, clientId, start, groupId, leg]);
    createdIds.push(rows[0].id);
    return rows[0].id;
  }

  // Turno ricorrente 08:00-16:00 Europe/Rome, valido per le missioni
  // del 14 gennaio 2032. NON inserire una seconda riga per lo stesso veicolo:
  // unique_disponibilita_veicolo impone una sola disponibilita per veicolo.
  // La modifica esiste solo nella transazione di test e verra annullata.
  const { rows: existingShifts } = await client.query(`
    SELECT id FROM disponibilita_veicolo
    WHERE veicolo_id=$1 FOR UPDATE
  `, [vehicleId]);
  if (existingShifts.length) {
    await client.query(`
      UPDATE disponibilita_veicolo
      SET start='2026-01-01T08:00:00+01'::timestamptz,
          fine='2026-01-01T16:00:00+01'::timestamptz,
          manual=FALSE,
          giorni_esclusi=ARRAY[]::integer[],
          inattivita='[]'
      WHERE veicolo_id=$1
    `, [vehicleId]);
    console.log('Disponibilita esistente adattata temporaneamente (ROLLBACK finale)');
  } else {
    await client.query(`
      INSERT INTO disponibilita_veicolo
        (veicolo_id, start, fine, manual, giorni_esclusi, inattivita)
      VALUES (
        $1, '2026-01-01T08:00:00+01'::timestamptz,
        '2026-01-01T16:00:00+01'::timestamptz,
        FALSE, ARRAY[]::integer[], '[]'
      )
    `, [vehicleId]);
    console.log('Disponibilita temporanea inserita (ROLLBACK finale)');
  }

  const group = await createGroup();
  const pendingId = await createPending(group);

  await success('accettazione valida crea una sola riserva provvisoria', async () => {
    const result = await accettaTrattaARAtomica({
      pendingId, operatoreId: operatorId, client, movement: movementOk
    });
    assert(result.creata && result.stato === 'provvisoria', 'Riserva non creata');
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ar_accettazioni
      WHERE pending_id=$1 AND stato='provvisoria'`, [pendingId]);
    assert(rows[0].n === 1, 'Numero riserve errato');
  });

  await expectedFailure('operatore non proprietario rifiutato',
    'AR_OPERATOR_NOT_AUTHORIZED', () => accettaTrattaARAtomica({
      pendingId, operatoreId: Number(operatorId) + 100000000, client,
      movement: movementOk
    }));

  await expectedFailure('turno mancante rifiutato', 'AR_SHIFT_UNAVAILABLE', async () => {
    await client.query('DELETE FROM disponibilita_veicolo WHERE veicolo_id=$1', [vehicleId]);
    await accettaTrattaARAtomica({ pendingId, operatoreId: operatorId,
      client, movement: movementOk });
  });

  await expectedFailure('sovrapposizione con riserva A/R rifiutata',
    'AR_VEHICLE_CONFLICT', async () => {
      const otherGroup = await createGroup();
      const otherPending = await createPending(otherGroup, startIso, 'andata');
      await registraAccettazioneProvvisoriaAR(client, {
        arGroupId: otherGroup, pendingId: otherPending, veicoloId: vehicleId
      });
      await accettaTrattaARAtomica({ pendingId, operatoreId: operatorId,
        client, movement: movementOk });
    });

  await expectedFailure('trasferimento stradale impossibile rifiutato',
    'AR_VEHICLE_TRANSFER_UNVERIFIED', async () => {
      const otherGroup = await createGroup();
      const otherPending = await createPending(otherGroup,
        '2032-01-14T08:30:00Z', 'andata');
      await registraAccettazioneProvvisoriaAR(client, {
        arGroupId: otherGroup, pendingId: otherPending, veicoloId: vehicleId
      });
      await accettaTrattaARAtomica({ pendingId, operatoreId: operatorId,
        client, movement: movementSlow });
    });

  await success('idempotenza: una sola accettazione per pending', async () => {
    const a = await accettaTrattaARAtomica({ pendingId,
      operatoreId: operatorId, client, movement: movementOk });
    const b = await accettaTrattaARAtomica({ pendingId,
      operatoreId: operatorId, client, movement: movementOk });
    assert(a.creata === true && b.creata === false, 'Idempotenza errata');
  });

  console.log('Verifiche concluse; eseguo ROLLBACK generale.');
} catch (error) {
  failed = true;
  console.error('TEST FALLITO:', error?.code ?? error?.message, error);
} finally {
  if (client) {
    try { await client.query('ROLLBACK'); console.log('ROLLBACK eseguito'); }
    catch (error) { failed = true; console.error('ROLLBACK FALLITO:', error); }
    finally { client.release(); }
  }
  // Verifica che i pending di test non siano rimasti nel DB.
  if (createdIds.length) {
    const check = await pool.query('SELECT id FROM pending WHERE id=ANY($1::integer[])', [createdIds]);
    if (check.rowCount !== 0) {
      failed = true;
      console.error('ERRORE: pending temporanei ancora presenti:', check.rows);
    } else console.log('Verifica persistenza: nessun pending temporaneo rimasto');
  }
  await pool.end();
}
console.log(`Risultato: ${passed}/6 test superati`);
if (failed || passed !== 6) process.exitCode = 1;
