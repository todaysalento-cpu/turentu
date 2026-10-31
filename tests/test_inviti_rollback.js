// TURENTU - Test inviti NCC in transazione esterna: NESSUN COMMIT REALE.
// Eseguire dalla root del backend: node tests/test_inviti_rollback.js
import { randomBytes } from 'node:crypto';
import { pool } from '../db/db.js';
import { preparaInvitoAnagrafica, accettaInvitoAnagrafica } from '../services/conducenti/inviti-anagrafica.service.js';

const suffix = randomBytes(8).toString('hex');
let passed = 0, failed = 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const expectError = async (fn, status, label) => {
  try { await fn(); throw new Error(`ATTESO RIFIUTO: ${label}`); }
  catch (error) {
    if (error.message.startsWith('ATTESO RIFIUTO:')) throw error;
    assert(error.status === status, `${label}: atteso HTTP ${status}, ottenuto ${error.status ?? error.code ?? error.message}`);
  }
};

const db = await pool.connect();
let outerStarted = false;
try {
  await db.query('BEGIN');
  outerStarted = true;
  // Il servizio chiama BEGIN/COMMIT/ROLLBACK su una connessione presa dal pool.
  // Questo adattatore converte SOLO quelle chiamate in SAVEPOINT, preservando
  // la transazione esterna. Nessun COMMIT raggiunge PostgreSQL.
  let seq = 0;
  const stack = [];
  const wrappedClient = {
    query: async (sql, params) => {
      if (typeof sql === 'string') {
        const cmd = sql.trim().replace(/;$/, '').toUpperCase();
        if (cmd === 'BEGIN') {
          const name = `turentu_service_${++seq}`;
          stack.push(name);
          return db.query(`SAVEPOINT ${name}`);
        }
        if (cmd === 'COMMIT') {
          const name = stack.pop();
          if (!name) throw new Error('COMMIT inatteso dal servizio');
          return db.query(`RELEASE SAVEPOINT ${name}`);
        }
        if (cmd === 'ROLLBACK') {
          const name = stack.pop();
          if (!name) throw new Error('ROLLBACK inatteso dal servizio');
          await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
          return db.query(`RELEASE SAVEPOINT ${name}`);
        }
      }
      return db.query(sql, params);
    },
    release: () => {}
  };
  const isolatedPool = { connect: async () => wrappedClient };
  let caseNo = 0;
  async function scenario(name, fn) {
    const sp = `turentu_case_${++caseNo}`;
    await db.query(`SAVEPOINT ${sp}`);
    try {
      await fn();
      passed++;
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}: ${error.message}`);
    } finally {
      // Ogni scenario viene annullato, anche se il servizio ha rilasciato i propri savepoint.
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await db.query(`RELEASE SAVEPOINT ${sp}`);
      stack.length = 0;
    }
  }
  async function user(label, tipo, verified = false) {
    const email = `${label}-${suffix}@example.invalid`;
    const { rows } = await db.query(`INSERT INTO public.utente (nome,email,password,tipo,email_verificata_il)
      VALUES ($1,$2,$3,$4,$5) RETURNING id,email`,
      [label, email, 'TEST_ONLY_NO_LOGIN', tipo, verified ? new Date() : null]);
    return rows[0];
  }
  async function fixture({ verified = true, secondOperator = false } = {}) {
    const op = await user('operatore', 'autista', true);
    const driver = await user('conducente', 'autista', verified);
    const op2 = secondOperator ? await user('operatore2', 'autista', true) : null;
    const { rows } = await db.query(`INSERT INTO public.anagrafica_conducenti
      (operatore_id,nome,cognome,email,stato) VALUES ($1,'Mario','Prova',$2,'bozza') RETURNING id`,
      [op.id, driver.email]);
    const anagraficaId = rows[0].id;
    const invite = await preparaInvitoAnagrafica(isolatedPool, {
      operatoreId: op.id, anagraficaId, baseUrl: 'https://turentu.example.invalid'
    });
    const token = new URL(invite.link).searchParams.get('token');
    assert(token && token.length === 64, 'Token non generato');
    return { op, driver, op2, anagraficaId, token };
  }
  const accept = (f, token = f.token) => accettaInvitoAnagrafica(isolatedPool, { utenteId: f.driver.id, token });

  await scenario('Email non verificata: rifiuto 403', async () => {
    const f = await fixture({ verified: false });
    await expectError(() => accept(f), 403, 'Email non verificata');
  });
  await scenario('Email differente: rifiuto 403', async () => {
    const f = await fixture();
    await db.query(`UPDATE public.utente SET email=$1 WHERE id=$2`, [`diversa-${suffix}@example.invalid`, f.driver.id]);
    await expectError(() => accept(f), 403, 'Email differente');
  });
  await scenario('Token scaduto: rifiuto 409', async () => {
    const f = await fixture();
    await db.query(`UPDATE public.inviti_anagrafica_conducenti SET creato_il=NOW()-INTERVAL '5 days', scade_il=NOW()-INTERVAL '2 days'
      WHERE anagrafica_id=$1`, [f.anagraficaId]);
    await expectError(() => accept(f), 409, 'Token scaduto');
  });
  await scenario('Token revocato: rifiuto 409', async () => {
    const f = await fixture();
    await db.query(`UPDATE public.inviti_anagrafica_conducenti SET revocato_il=NOW()
      WHERE anagrafica_id=$1`, [f.anagraficaId]);
    await expectError(() => accept(f), 409, 'Token revocato');
  });
  await scenario('Token gia consumato: rifiuto 409', async () => {
    const f = await fixture();
    await db.query(`UPDATE public.inviti_anagrafica_conducenti SET consumato_il=NOW()
      WHERE anagrafica_id=$1`, [f.anagraficaId]);
    await expectError(() => accept(f), 409, 'Token consumato');
  });
  await scenario('Invito valido: collega e consuma token', async () => {
    const f = await fixture();
    const result = await accept(f);
    assert(result.stato === 'collegato', 'Stato risposta non collegato');
    const { rows: a } = await db.query(`SELECT stato,utente_id FROM public.anagrafica_conducenti WHERE id=$1`, [f.anagraficaId]);
    assert(a[0].stato === 'collegato' && a[0].utente_id === f.driver.id, 'Anagrafica non collegata');
    const { rows: c } = await db.query(`SELECT stato FROM public.conducenti_operatori WHERE operatore_id=$1 AND conducente_id=$2`, [f.op.id, f.driver.id]);
    assert(c.length === 1 && c[0].stato === 'attivo', 'Associazione NCC non attiva');
    const { rows: i } = await db.query(`SELECT consumato_il FROM public.inviti_anagrafica_conducenti WHERE anagrafica_id=$1`, [f.anagraficaId]);
    assert(i[0].consumato_il !== null, 'Token non consumato');
    await expectError(() => accept(f), 409, 'Riutilizzo dopo accettazione');
  });
  await scenario('Altro operatore attivo: rifiuto 409', async () => {
    const f = await fixture({ secondOperator: true });
    await db.query(`INSERT INTO public.conducenti_operatori (operatore_id,conducente_id,stato)
      VALUES ($1,$2,'attivo')`, [f.op2.id, f.driver.id]);
    await expectError(() => accept(f), 409, 'Gia attivo altrove');
  });
  await scenario('Indice unico impedisce due operatori attivi', async () => {
    const f = await fixture({ secondOperator: true });
    await db.query(`INSERT INTO public.conducenti_operatori (operatore_id,conducente_id,stato)
      VALUES ($1,$2,'attivo')`, [f.op.id, f.driver.id]);
    await db.query('SAVEPOINT unique_guard');
    let blocked = false;
    try {
      await db.query(`INSERT INTO public.conducenti_operatori (operatore_id,conducente_id,stato)
        VALUES ($1,$2,'attivo')`, [f.op2.id, f.driver.id]);
    } catch (e) {
      blocked = e.code === '23505';
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT unique_guard');
      await db.query('RELEASE SAVEPOINT unique_guard');
    }
    assert(blocked, 'Indice unico non ha bloccato la seconda associazione');
  });
} catch (error) {
  failed++;
  console.error('ERRORE TEST:', error);
} finally {
  if (outerStarted) {
    try { await db.query('ROLLBACK'); console.log('ROLLBACK esterno eseguito: dati di test non conservati'); }
    catch (error) { console.error('ERRORE ROLLBACK:', error); failed++; }
  }
  db.release();
  await pool.end();
}
console.log(`RISULTATO: ${passed} PASS, ${failed} FAIL`);
if (failed) process.exitCode = 1;
