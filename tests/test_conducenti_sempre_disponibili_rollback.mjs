import { pool } from '../db/db.js';
import { assegnaConducente } from '../services/conducenti/assegnazioni.service.js';

// TURENTU: collaudo integrato, nessun COMMIT.
// Eseguire dalla root backend con: node --env-file=.env tests/test_conducenti_sempre_disponibili_rollback.mjs
const client = await pool.connect();
let transactionOpen = false;
let failures = 0;
const OP = 2, DRIVER = 101, VEHICLE = 364, RIDE = 923;
const START = '2026-12-08T10:00:00+01:00';
const END = '2026-12-08T12:00:00+01:00';
const relationship = { id: null };

function assert(condition, message) { if (!condition) throw new Error(message); }
async function test(label, fn) {
  const name = `sp_${String(++test.sequence)}`;
  await client.query(`SAVEPOINT ${name}`);
  try { await fn(); console.log(`PASS ${label}`); }
  catch (e) { failures++; console.error(`FAIL ${label}: ${e.code || ''} ${e.message}`); }
  finally { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); await client.query(`RELEASE SAVEPOINT ${name}`); }
}
test.sequence = 0;

async function expectCode(action, expected) {
  const sp = `expected_${++test.sequence}`;
  await client.query(`SAVEPOINT ${sp}`);
  let error;
  try { await action(); } catch (e) { error = e; }
  await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  await client.query(`RELEASE SAVEPOINT ${sp}`);
  assert(error?.code === expected, `Atteso ${expected}, ricevuto ${error?.code || 'nessun errore'} (${error?.message || 'operazione riuscita'})`);
}

async function assign(overrides = {}) {
  return assegnaConducente(client, {
    operatoreId: OP, conducenteId: DRIVER, veicoloId: VEHICLE, corsaId: RIDE,
    modalita: 'manuale', usaCicloPersistito: true, ...overrides
  });
}

async function insertAbsence() {
  await client.query(`INSERT INTO eccezioni_turni_conducenti
    (id, rapporto_id, intervallo, tipo, nota)
    VALUES ((SELECT COALESCE(MIN(id),0)-1 FROM eccezioni_turni_conducenti),$1,
      tstzrange($2::timestamptz,$3::timestamptz,'[)'), 'indisponibile','Test rollback')`,
    [relationship.id, START, END]);
}

try {
  await client.query('BEGIN'); transactionOpen = true;
  await client.query("SET LOCAL lock_timeout='3s'");
  await client.query("SET LOCAL statement_timeout='15s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='60s'");

  const { rows: rel } = await client.query(`SELECT id FROM conducenti_operatori
    WHERE operatore_id=$1 AND conducente_id=$2 AND stato='attivo' FOR UPDATE`, [OP, DRIVER]);
  assert(rel.length === 1, 'Rapporto conducente attivo non trovato');
  relationship.id = rel[0].id;
  const { rows: rides } = await client.query(`SELECT c.id FROM corse c JOIN veicolo v ON v.id=c.veicolo_id
    WHERE c.id=$1 AND v.id=$2 AND v.driver_id=$3 AND c.stato IN ('prenotabile','da_attivare')
      AND c.tipo_corsa IN ('privata','condivisa') FOR UPDATE OF c`, [RIDE, VEHICLE, OP]);
  assert(rides.length === 1, 'Corsa/veicolo non idonei');
  const { rows: assignments } = await client.query(`SELECT id FROM assegnazioni_conducenti
    WHERE stato='assegnata' AND (corsa_id=$1 OR veicolo_id=$2 OR
      (conducente_id=$3 AND intervallo_operativo && tstzrange($4::timestamptz,$5::timestamptz,'[)')))
    LIMIT 1`, [RIDE, VEHICLE, DRIVER, START, END]);
  assert(assignments.length === 0, 'Esistono assegnazioni preesistenti: test interrotto');

  await client.query(`UPDATE corse SET inizio_ciclo_operativo=$1::timestamptz,
    fine_ciclo_operativo=$2::timestamptz WHERE id=$3`, [START, END, RIDE]);

  await test('sempre disponibile senza turni', async () => {
    await client.query('UPDATE conducenti_operatori SET sempre_disponibile=true WHERE id=$1', [relationship.id]);
    // Isola il caso dalle eccezioni reali nella finestra scelta.
    await client.query(`DELETE FROM eccezioni_turni_conducenti WHERE rapporto_id=$1
      AND intervallo && tstzrange($2::timestamptz,$3::timestamptz,'[)')`, [relationship.id, START, END]);
    const result = await assign();
    assert(result.conducente_id == DRIVER && result.deroga_turno === false, 'Assegnazione senza deroga non riuscita');
  });

  await test('indisponibilita richiede deroga manuale', async () => {
    await client.query('UPDATE conducenti_operatori SET sempre_disponibile=true WHERE id=$1', [relationship.id]);
    await insertAbsence();
    await expectCode(() => assign(), 'CONDUCENTE_DEROGA_RICHIESTA');
  });

  await test('deroga manuale tracciata', async () => {
    await client.query('UPDATE conducenti_operatori SET sempre_disponibile=true WHERE id=$1', [relationship.id]);
    await insertAbsence();
    const result = await assign({ confermaDeroga: true, motivoDeroga: 'Collaudo autorizzazione operatore', autorizzatoreId: OP });
    assert(result.deroga_turno === true && result.deroga_autorizzata_da == OP && !!result.deroga_autorizzata_il, 'Deroga non tracciata');
  });

  await test('sovrapposizione bloccata anche con deroga', async () => {
    await client.query('UPDATE conducenti_operatori SET sempre_disponibile=true WHERE id=$1', [relationship.id]);
    await insertAbsence();
    await assign({ confermaDeroga: true, motivoDeroga: 'Collaudo conflitto operatore', autorizzatoreId: OP });
    await expectCode(() => assign({ confermaDeroga: true, motivoDeroga: 'Seconda autorizzazione test', autorizzatoreId: OP }), 'CONDUCENTE_CONFLITTO');
  });

  await test('modalita turni senza copertura richiede deroga', async () => {
    await client.query('UPDATE conducenti_operatori SET sempre_disponibile=false WHERE id=$1', [relationship.id]);
    await client.query('DELETE FROM turni_conducenti WHERE rapporto_id=$1', [relationship.id]);
    await client.query('DELETE FROM eccezioni_turni_conducenti WHERE rapporto_id=$1', [relationship.id]);
    await expectCode(() => assign(), 'CONDUCENTE_DEROGA_RICHIESTA');
  });

  console.log(failures ? `ESITO: ${failures} TEST FALLITI` : 'ESITO: TUTTI I TEST SUPERATI');
} catch (e) {
  failures++;
  console.error('ERRORE PRECONDIZIONE/COLLAUDO:', e.code || '', e.message);
} finally {
  if (transactionOpen) {
    try { await client.query('ROLLBACK'); console.log('ROLLBACK ESEGUITO'); }
    catch (e) { failures++; console.error('ERRORE CRITICO ROLLBACK:', e.message); }
  }
  client.release(true);
  await pool.end();
  if (failures) process.exitCode = 1;
}
