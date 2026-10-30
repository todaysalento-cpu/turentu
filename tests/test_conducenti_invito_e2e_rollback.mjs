import { pool } from '../db/db.js';
import {
  invitaConducente,
  elencoInvitiConducente,
  rifiutaInvitoConducente,
  accettaInvitoConducente,
  rapportoAttivoConducente
} from '../services/conducenti/conducenti.service.js';

const OPERATORE_ID = 2;
const CONDUCENTE_ID = 4;

const assert = (v, m) => {
  if (!v) throw new Error('TEST FALLITO: ' + m);
};

let client;
let begun = false;
let fixtureAttempted = false;
let passed = false;

try {
  assert(
    process.env.TURENTU_ISOLATED_TEST_DB === 'YES',
    'Conferma DB isolato mancante'
  );

  assert(
    process.env.TURENTU_ALLOW_CONDUCENTE_ROLLBACK_TEST === 'YES',
    'Autorizzazione test rollback mancante'
  );

  client = await pool.connect();

  const db = await client.query(`
    SELECT current_database() AS db,
           current_user AS utente,
           inet_server_addr()::text AS server
  `);

  console.log('DB TEST:', db.rows[0]);

  assert(db.rows[0].db === 'corse_db', 'Database inatteso');

  await client.query('BEGIN');
  begun = true;

  await client.query("SET LOCAL statement_timeout = '30s'");

  const users = await client.query(`
    SELECT id, tipo
      FROM utente
     WHERE id = ANY($1::int[])
     FOR SHARE
  `, [[OPERATORE_ID, CONDUCENTE_ID]]);

  const operator = users.rows.find(x => x.id === OPERATORE_ID);
  const conductor = users.rows.find(x => x.id === CONDUCENTE_ID);

  assert(operator?.tipo === 'autista', 'Operatore NCC non valido');
  assert(conductor?.tipo === 'cliente', 'Utente conducente non valido');

  const existing = await client.query(`
    SELECT id, stato
      FROM conducenti_operatori
     WHERE operatore_id = $1
       AND conducente_id = $2
  `, [OPERATORE_ID, CONDUCENTE_ID]);

  assert(existing.rowCount === 0, 'Associazione già esistente');

  fixtureAttempted = true;

  // SCENARIO 1: INVITO
  const invito = await invitaConducente(client, {
    operatoreId: OPERATORE_ID,
    conducenteId: CONDUCENTE_ID
  });

  assert(invito.stato === 'invitato', 'Invito non creato');

  const rapportoId = Number(invito.id);

  console.log('SCENARIO_1_OK: invito creato', rapportoId);

  // SCENARIO 2: VISUALIZZAZIONE
  const inviti = await elencoInvitiConducente(
    client,
    CONDUCENTE_ID
  );

  assert(
    inviti.some(x => Number(x.id) === rapportoId),
    'Invito non visibile al conducente'
  );

  console.log('SCENARIO_2_OK: invito visibile');

  // SCENARIO 3: RIFIUTO
  const rifiutato = await rifiutaInvitoConducente(client, {
    rapportoId,
    conducenteId: CONDUCENTE_ID
  });

  assert(rifiutato.stato === 'rifiutato', 'Rifiuto non registrato');

  console.log('SCENARIO_3_OK: invito rifiutato');

  // SCENARIO 4: REINVITO
  const reinvito = await invitaConducente(client, {
    operatoreId: OPERATORE_ID,
    conducenteId: CONDUCENTE_ID
  });

  assert(reinvito.stato === 'invitato', 'Reinvito fallito');
  assert(Number(reinvito.id) === rapportoId, 'ID rapporto modificato');

  console.log('SCENARIO_4_OK: reinvito effettuato');

  // SCENARIO 5: ACCETTAZIONE
  const accettato = await accettaInvitoConducente(client, {
    rapportoId,
    conducenteId: CONDUCENTE_ID
  });

  assert(accettato.stato === 'attivo', 'Accettazione fallita');

  console.log('SCENARIO_5_OK: invito accettato');

  // SCENARIO 6: RAPPORTO ATTIVO
  const rapporti = await rapportoAttivoConducente(
    client,
    CONDUCENTE_ID
  );

  const rapporto = rapporti.find(
    x => Number(x.rapporto_id) === rapportoId
  );

  assert(rapporto, 'Rapporto attivo non trovato');
  assert(
    Number(rapporto.operatore_id) === OPERATORE_ID,
    'Operatore associato errato'
  );

  console.log('SCENARIO_6_OK: rapporto attivo verificato');

  passed = true;

} catch (e) {
  console.error('CONDUCENTI_E2E_ERROR:', e.stack || e.message);
  process.exitCode = 1;

} finally {
  if (begun) {
    try {
      await client.query('ROLLBACK');
      console.log('CONDUCENTI_E2E_ROLLBACK_OK');
    } catch (e) {
      console.error('ROLLBACK_ERROR:', e.message);
      process.exitCode = 1;
    }
  }

  client?.release();

  if (fixtureAttempted) {
    const verify = await pool.connect();

    try {
      const r = await verify.query(`
        SELECT count(*)::int AS residui
          FROM conducenti_operatori
         WHERE operatore_id = $1
           AND conducente_id = $2
      `, [OPERATORE_ID, CONDUCENTE_ID]);

      const clean = r.rows[0].residui === 0;

      console.log('CONDUCENTI_E2E_VERIFY_JSON:' +
        JSON.stringify({
          passed: clean,
          associazioniResidue: r.rows[0].residui
        })
      );

      if (!clean) process.exitCode = 1;

    } catch (e) {
      console.error('VERIFY_ERROR:', e.message);
      process.exitCode = 1;
    } finally {
      verify.release();
    }
  }

  if (!passed) process.exitCode = 1;

  await pool.end();
}
