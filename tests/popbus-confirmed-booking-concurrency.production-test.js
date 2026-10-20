// Turentu POPBUS V2 - test integrazione riserve con due connessioni PostgreSQL.
// Modalita preflight SOLO LETTURA per default. Scritture solo con doppia conferma esplicita.
// Richiede una corsa DEDICATA futura riempimento/prenotabile con attivazione confermata,
// senza prenotazioni o riserve, e un utente cliente esistente.
// Non usa Stripe, non modifica worker/route. Le riserve del test sono eliminate.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/db.js';
import { riservaPostiPopbus } from '../services/popbus/v2/confirmed-booking.service.js';

const env = process.env;
const num = (name) => Number(env[name]);
const corsaId = num('POPBUS_TEST_CORSA_ID');
const clienteId = num('POPBUS_TEST_CLIENTE_ID');
const startOffset = num('POPBUS_TEST_START_OFFSET');
const endOffset = num('POPBUS_TEST_END_OFFSET');
const startIndexPolyline = num('POPBUS_TEST_START_INDEX');
const endIndexPolyline = num('POPBUS_TEST_END_INDEX');
const prezzo = 1.00;
const created = [];
const log = (...args) => console.log('[POPBUS-TEST]', ...args);

async function main() {
  const identity = await pool.query('SELECT current_database() AS db, current_user AS username');
  const db = identity.rows[0].db;
  log('Database collegato:', db, '| utente:', identity.rows[0].username);
  // Identita DB obbligatoria, per evitare scritture sull'istanza sbagliata.
  if (!env.POPBUS_TEST_EXPECT_DB || db !== env.POPBUS_TEST_EXPECT_DB) {
    throw new Error(`STOP: database '${db}' diverso da POPBUS_TEST_EXPECT_DB`);
  }
  const writeMode = env.POPBUS_TEST_MODE === 'RUN';
  if (writeMode && (env.POPBUS_TEST_ALLOW_WRITES !== 'YES' ||
                    env.POPBUS_TEST_CONFIRM_PRODUCTION !== 'I_UNDERSTAND')) {
    throw new Error('STOP: RUN richiede POPBUS_TEST_ALLOW_WRITES=YES e POPBUS_TEST_CONFIRM_PRODUCTION=I_UNDERSTAND');
  }
  if (!writeMode && env.POPBUS_TEST_MODE && env.POPBUS_TEST_MODE !== 'DRY_RUN') {
    throw new Error('POPBUS_TEST_MODE deve essere DRY_RUN o RUN');
  }
  if (![corsaId, clienteId, startIndexPolyline, endIndexPolyline].every(v => Number.isSafeInteger(v) && v >= 0) ||
      corsaId < 1 || clienteId < 1 || endIndexPolyline <= startIndexPolyline ||
      !Number.isFinite(startOffset) || !Number.isFinite(endOffset) ||
      startOffset < 0 || endOffset <= startOffset) {
    throw new Error('Fixture non configurata: servono POPBUS_TEST_CORSA_ID, CLIENTE_ID, START_OFFSET, END_OFFSET, START_INDEX, END_INDEX.');
  }
  const fixture = await pool.query(`
    SELECT c.id, c.posti_totali, c.start_datetime, c.stato, c.tipo_corsa,
      EXISTS(SELECT 1 FROM public.popbus_attivazioni a
             WHERE a.corsa_id=c.id AND a.stato='confermata') AS confermata,
      (SELECT COUNT(*)::int FROM public.prenotazioni p WHERE p.corsa_id=c.id) AS bookings,
      (SELECT COUNT(*)::int FROM public.popbus_riserve r WHERE r.corsa_id=c.id) AS reserves
    FROM public.corse c WHERE c.id=$1`, [corsaId]);
  const c = fixture.rows[0];
  if (!c || c.tipo_corsa !== 'riempimento' || c.stato !== 'prenotabile' ||
      new Date(c.start_datetime) <= new Date() || !c.confermata ||
      c.bookings !== 0 || c.reserves !== 0 || !Number.isInteger(c.posti_totali) || c.posti_totali < 2) {
    throw new Error('Fixture non sicura: occorre corsa POPBUS futura, confermata, prenotabile, capacità >=2, senza prenotazioni/riserve.');
  }
  const user = await pool.query('SELECT id FROM public.utente WHERE id=$1', [clienteId]);
  if (!user.rowCount) throw new Error('Cliente fixture inesistente');
  log('Fixture validata, corsa', corsaId, 'capacità', c.posti_totali);
  if (!writeMode) {
    log('DRY_RUN OK: nessuna scrittura eseguita. Per RUN servono conferme esplicite e backup.');
    return;
  }
  const params = postiRichiesti => ({
    requestId: randomUUID(), corsaId, clienteId, postiRichiesti,
    startOffset, endOffset, startIndexPolyline, endIndexPolyline, prezzo
  });

  // A: la creazione all'interno di una transazione esterna si annulla col rollback.
  const rollbackClient = await pool.connect();
  try {
    await rollbackClient.query('BEGIN');
    const r = await riservaPostiPopbus(params(1), rollbackClient);
    assert.equal(r.stato, 'riservata');
    await rollbackClient.query('ROLLBACK');
    const check = await pool.query('SELECT COUNT(*)::int AS n FROM public.popbus_riserve WHERE id=$1', [r.id]);
    assert.equal(check.rows[0].n, 0);
    log('PASS rollback transazione esterna');
  } catch (e) {
    await rollbackClient.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { rollbackClient.release(); }

  // B: riempi tutti i posti meno uno con una riserva committed.
  const base = await riservaPostiPopbus(params(c.posti_totali - 1));
  created.push(base.id);
  log('Riserva base creata:', base.id);

  // C: due connessioni autonome tentano simultaneamente l'ultimo posto.
  // Promise.allSettled attende entrambe, anche in caso di fallimento.
  const outcomes = await Promise.allSettled([
    riservaPostiPopbus(params(1)),
    riservaPostiPopbus(params(1))
  ]);
  for (const result of outcomes) if (result.status === 'fulfilled') created.push(result.value.id);
  const success = outcomes.filter(r => r.status === 'fulfilled');
  const failed = outcomes.filter(r => r.status === 'rejected');
  log('Concorrenza:', success.length, 'successo/i,', failed.length, 'rifiuto/i');
  for (const f of failed) log('Rifiuto atteso:', f.reason?.message);
  assert.equal(success.length, 1, 'Deve vincere una sola prenotazione concorrente');
  assert.equal(failed.length, 1, 'La seconda prenotazione deve essere respinta');
  const count = await pool.query(`
    SELECT COALESCE(SUM(posti_richiesti),0)::int AS occupati
    FROM public.popbus_riserve
    WHERE corsa_id=$1 AND stato='riservata' AND expires_at>NOW()`, [corsaId]);
  assert.equal(count.rows[0].occupati, c.posti_totali);
  log('PASS: nessun overbooking sulla stessa tratta');
  log('NOTA: conferma Stripe e consolidamento prenotazione non sono testati qui.');
}

try {
  await main();
  console.log(env.POPBUS_TEST_MODE === 'RUN' ? 'PASS - TEST RISERVE POPBUS COMPLETATO' : 'PASS - PREFLIGHT SOLA LETTURA');
} catch (error) {
  console.error('FAIL -', error.message);
  process.exitCode = 1;
} finally {
  if (created.length) {
    try {
      // Pulizia dei soli ID creati dal test. Nessuna prenotazione definitiva viene creata.
      const result = await pool.query(`
        DELETE FROM public.popbus_riserve
        WHERE id = ANY($1::bigint[]) AND stato='riservata' AND payment_intent_id IS NULL
        RETURNING id`, [created]);
      log('Pulizia riserve test:', result.rowCount, '/', created.length);
      if (result.rowCount !== created.length) process.exitCode = 1;
    } catch (error) {
      console.error('ATTENZIONE: pulizia non riuscita, IDs:', created.join(','), error.message);
      process.exitCode = 1;
    }
  }
  await pool.end();
}
