// Turentu - test 3 scenari assegnazioni conducenti, ROLLBACK obbligatorio.
// Copiare in tests/test_popbus_conflitto_conducenti_rollback.mjs
// SOLO database di test realmente separato. Il flag NON prova l'isolamento.
// Non invoca Stripe, worker, acceptance; non esegue COMMIT.
import { pool } from '../db/db.js';
import { assegnaConducente } from '../services/popbus/v2/assegnazioni.service.js';

const assert = (ok, msg) => { if (!ok) throw new Error('TEST FALLITO: ' + msg); };
assert(process.env.TURENTU_ISOLATED_TEST_DB === 'YES', 'DB di test isolato non dichiarato');
assert(process.env.TURENTU_ALLOW_CONDUCENTE_ROLLBACK_TEST === 'YES', 'Flag test non abilitato');

const op = 2, titolare = 2, dipendente = 101, v1 = 361, v2 = 362;
const A = ['2026-11-02T10:00:00+01:00', '2026-11-02T11:00:00+01:00'];
const B = ['2026-11-02T11:00:00+01:00', '2026-11-02T12:00:00+01:00'];
let client, begun = false, ids = [], baseline = null, ok = false;
const count = async (sql, args=[]) => Number((await client.query(sql,args)).rows[0].n);
const target = (veicoloId, attivazioneId, conducenteId, modalita, periodo) => ({
  operatoreId:op, veicoloId, attivazioneId, conducenteId, modalita,
  inizio:periodo[0], fine:periodo[1]
});
const active = async () => count(`SELECT COUNT(*)::int AS n FROM assegnazioni_conducenti
  WHERE attivazione_id = ANY($1::bigint[]) AND stato='assegnata'`, [ids]);
const savepoint = async (name, fn) => {
  await client.query(`SAVEPOINT ${name}`);
  try { await fn(); }
  finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  }
};

try {
  client = await pool.connect();
  const db = (await client.query(`SELECT current_database() AS db, inet_server_addr()::text AS host`)).rows[0];
  console.log('DB TEST (isolamento da verificare esternamente):', db);
  await client.query('BEGIN'); begun = true;
  await client.query("SET LOCAL statement_timeout = '20s'");
  await client.query("SET LOCAL lock_timeout = '3s'");

  const { rows: veicoli } = await client.query(
    `SELECT id FROM veicolo WHERE driver_id=$1 AND id=ANY($2::int[])`, [op,[v1,v2]]);
  assert(veicoli.length === 2, 'I due veicoli non appartengono entrambi all operatore');
  const { rows: rapporti } = await client.query(
    `SELECT id FROM conducenti_operatori WHERE operatore_id=$1 AND conducente_id=$2 AND stato='attivo'`,
    [op,dipendente]);
  assert(rapporti.length === 1, 'Conducente 101 non associato o non attivo');
  // Evita falsi esiti dovuti ad assegnazioni gia presenti.
  const { rows: pre } = await client.query(`
    SELECT id, conducente_id FROM assegnazioni_conducenti
    WHERE conducente_id=ANY($1::int[]) AND stato='assegnata'
      AND intervallo_operativo && tstzrange($2::timestamptz,$3::timestamptz,'[)')
    LIMIT 10`, [[titolare,dipendente], A[0], B[1]]);
  assert(pre.length === 0, 'Esistono assegnazioni preesistenti sovrapposte: scegliere un altro lunedi');
  baseline = await count('SELECT COUNT(*)::int AS n FROM assegnazioni_conducenti');

  // Fixture temporanee: riusa la struttura gia collaudata per popbus_attivazioni.
  for (const veicoloId of [v1,v2]) {
    const { rows } = await client.query(`
      INSERT INTO popbus_attivazioni
        (veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,expires_at)
      VALUES ($1,$2,'in_attesa_autista',$3::timestamptz,$4::timestamptz,0,0,0,'{}'::jsonb,$5::timestamptz)
      RETURNING id`, [veicoloId,op,A[0],B[1],'2026-11-02T13:00:00+01:00']);
    ids.push(rows[0].id);
  }
  assert(ids.length === 2, 'Fixture incomplete');

  // 1) Titolare contemporaneo su due veicoli: rifiuto seconda assegnazione.
  await savepoint('scenario_uno', async () => {
    const first = await assegnaConducente(client,target(v1,ids[0],titolare,'titolare',A));
    assert(Number(first.conducente_id) === titolare, 'Prima assegnazione titolare errata');
    await client.query('SAVEPOINT tentativo_conflitto');
    let error = null;
    try { await assegnaConducente(client,target(v2,ids[1],titolare,'titolare',A)); }
    catch (e) { error=e; }
    finally {
      await client.query('ROLLBACK TO SAVEPOINT tentativo_conflitto');
      await client.query('RELEASE SAVEPOINT tentativo_conflitto');
    }
    assert(error && /impegnato|overlap|exclude|conflict/i.test(error.message),
      'Conflitto non rifiutato con motivazione attesa: '+(error?.message ?? 'nessun errore'));
    assert(await active() === 1, 'La prima assegnazione non e rimasta valida');
    console.log('SCENARIO_1_OK: stesso conducente, sovrapposizione rifiutata');
  });
  assert(await active() === 0, 'Residui scenario 1');

  // 2) Stesso titolare su due veicoli, fasce consecutive: entrambe consentite.
  await savepoint('scenario_due', async () => {
    await assegnaConducente(client,target(v1,ids[0],titolare,'titolare',A));
    await assegnaConducente(client,target(v2,ids[1],titolare,'titolare',B));
    assert(await active() === 2, 'Assegnazioni consecutive non consentite');
    console.log('SCENARIO_2_OK: stesso conducente, orari consecutivi consentiti');
  });
  assert(await active() === 0, 'Residui scenario 2');

  // 3) Due conducenti diversi, due veicoli, stessa fascia.
  // 101 e manuale (non automatico) e il lunedi 10-11 rientra nel turno.
  await savepoint('scenario_tre', async () => {
    const a = await assegnaConducente(client,target(v1,ids[0],titolare,'titolare',A));
    const b = await assegnaConducente(client,target(v2,ids[1],dipendente,'manuale',A));
    assert(Number(a.conducente_id) === titolare && Number(b.conducente_id) === dipendente,
      'Conducenti assegnati non corretti');
    assert(b.deroga_turno === false, 'Il dipendente richiede deroga: verificare turno');
    assert(await active() === 2, 'Due conducenti diversi non assegnati');
    console.log('SCENARIO_3_OK: due conducenti diversi simultanei, senza deroga');
  });
  assert(await active() === 0, 'Residui scenario 3');
  ok = true;
  console.log('POPBUS_CONFLITTO_CONDUCENTI_3_SCENARI_OK');
} catch (e) {
  console.error('POPBUS_CONFLITTO_CONDUCENTI_ERRORE:',e.code ?? '',e.message);
  process.exitCode = 1;
} finally {
  if (client) {
    if (begun) {
      try { await client.query('ROLLBACK'); console.log('POPBUS_CONFLITTO_CONDUCENTI_ROLLBACK_OK'); }
      catch (e) { console.error('ROLLBACK FALLITO:',e.message); process.exitCode=1; }
    }
    try {
      if (ids.length) {
        const residues = await count(`SELECT COUNT(*)::int AS n FROM popbus_attivazioni
          WHERE id=ANY($1::bigint[])`,[ids]);
        const assignments = await count(`SELECT COUNT(*)::int AS n FROM assegnazioni_conducenti
          WHERE attivazione_id=ANY($1::bigint[])`,[ids]);
        assert(residues===0 && assignments===0, 'Fixture o assegnazioni residue');
      }
      if (baseline != null) assert(await count('SELECT COUNT(*)::int AS n FROM assegnazioni_conducenti')===baseline,
        'Conteggio globale assegnazioni variato');
      console.log('POPBUS_CONFLITTO_CONDUCENTI_VERIFY_JSON:'+JSON.stringify({passed:ok,fixtureAssenti:true,assegnazioniAssenti:true}));
    } catch(e) { console.error('VERIFICA_FINALE_FALLITA:',e.message); process.exitCode=1; }
    client.release();
  }
  await pool.end();
  if(!ok) process.exitCode=1;
}
