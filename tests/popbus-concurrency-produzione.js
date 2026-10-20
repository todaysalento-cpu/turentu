// Turentu POPBUS V2: test controllato su DB reale. Copiare come tests/popbus-concurrency-produzione.js
// DRY RUN di default. NON eseguire RUN prima di backup e sospensione di TUTTI i worker/scheduler.
// Nessuna chiamata Stripe. Crea una corsa e un'attivazione sintetiche COMMITTED;
// elimina solo i record tracciati. In caso di crash, usare gli ID stampati per verifica manuale.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/db.js';
import { riservaPostiPopbus } from '../services/popbus/v2/confirmed-booking.service.js';

const RUN = process.env.POPBUS_TEST_MODE === 'RUN';
const PREFIX = 'TST_POPBUS_CONC_' + randomUUID();
const VEICOLO_ID = 347; // Veicolo 347: 4 posti, operatore 2 (verificato via SQL)
const CLIENTE_ID = Number(process.env.POPBUS_TEST_CLIENTE_ID || 0);
const created = { corsa: null, attivazione: null, riserve: [] };
let cleanupFailed = false;
const log = (...a) => console.log('[POPBUS TEST]', ...a);

async function prerequisites() {
  const { rows: [identity] } = await pool.query(`SELECT current_database() AS db, current_user AS usr`);
  log('DB:', identity.db, 'utente:', identity.usr, 'modalita:', RUN ? 'RUN' : 'DRY_RUN');
  if (identity.db !== 'corse_db') throw new Error('STOP: database inatteso: ' + identity.db);
  const { rows: [vehicle] } = await pool.query(`
    SELECT v.id, v.driver_id, v.posti_totali FROM public.veicolo v
    JOIN public.utente u ON u.id=v.driver_id WHERE v.id=$1`, [VEICOLO_ID]);
  assert(vehicle && Number(vehicle.posti_totali) === 4 && Number(vehicle.driver_id) === 2,
    'Veicolo/operatore non coerenti con i dati verificati');
  const { rows: [customer] } = await pool.query('SELECT id FROM public.utente WHERE id=$1', [CLIENTE_ID]);
  assert(customer, 'POPBUS_TEST_CLIENTE_ID non esiste: indicare un utente di test');
  if (RUN) {
    assert.equal(process.env.POPBUS_TEST_ALLOW_PRODUCTION, 'YES', 'Autorizzazione produzione mancante');
    assert.equal(process.env.POPBUS_TEST_WORKERS_STOPPED, 'YES', 'Conferma arresto worker mancante');
    assert.equal(process.env.POPBUS_TEST_BACKUP_DONE, 'YES', 'Conferma backup mancante');
  }
  log('Prerequisiti verificati. Veicolo', VEICOLO_ID, 'cliente', CLIENTE_ID);
}

async function createFixture() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='5s'`);
    const start = new Date(Date.now() + 30 * 86400000);
    const end = new Date(start.getTime() + 60 * 60000);
    const { rows: [c] } = await client.query(`
      INSERT INTO public.corse
      (veicolo_id,start_datetime,arrivo_datetime,tipo_corsa,stato,posti_totali,
       posti_disponibili,posti_prenotati,origine_address,destinazione_address)
      VALUES ($1,$2,$3,'riempimento','prenotabile',4,4,0,$4,$4)
      RETURNING id`, [VEICOLO_ID,start,end,PREFIX]);
    created.corsa = c.id;
    const { rows: [a] } = await client.query(`
      INSERT INTO public.popbus_attivazioni
      (veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,corsa_id,expires_at)
      VALUES ($1,$2,'confermata',$3,$4,0,0,0,$5::jsonb,$6,$7)
      RETURNING id`, [VEICOLO_ID,2,start,end,JSON.stringify({test: PREFIX}),c.id,end]);
    created.attivazione = a.id;
    await client.query('COMMIT');
    log('FIXTURE COMMITTED: corsa', c.id, 'attivazione', a.id, 'marker', PREFIX);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // Se il COMMIT fallisce, gli ID non sono necessariamente presenti: cleanup verifica.
    throw e;
  } finally { client.release(); }
}

function params(seats) {
  return { requestId: randomUUID(), corsaId: created.corsa, clienteId: CLIENTE_ID,
    postiRichiesti: seats, startOffset: 0, endOffset: 10000,
    startIndexPolyline: 0, endIndexPolyline: 1, prezzo: 1.00 };
}

async function attempt() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='10s'`);
    await client.query(`SET LOCAL statement_timeout='20s'`);
    const r = await riservaPostiPopbus(params(1), client);
    // Salvare l'ID PRIMA del commit per agevolare la pulizia in caso di errore.
    created.riserve.push(r.id);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function test() {
  const base = await riservaPostiPopbus(params(3));
  created.riserve.push(base.id);
  const outcomes = await Promise.allSettled([attempt(), attempt()]);
  const success = outcomes.filter(x => x.status === 'fulfilled');
  const failures = outcomes.filter(x => x.status === 'rejected');
  failures.forEach(x => log('Rifiuto concorrente:', x.reason?.message));
  assert.equal(success.length, 1, 'Deve riuscire una sola richiesta concorrente');
  assert.equal(failures.length, 1, 'Deve fallire una sola richiesta concorrente');
  const { rows: [r] } = await pool.query(`
    SELECT COALESCE(SUM(posti_richiesti),0)::int AS occupati
    FROM public.popbus_riserve
    WHERE corsa_id=$1 AND stato='riservata' AND expires_at>NOW()`, [created.corsa]);
  assert.equal(r.occupati, 4, 'Occupazione attesa: 4/4');
  log('PASS: 3 posti + 1 concorrente, secondo concorrente respinto, 4/4');
}

async function cleanup() {
  if (!created.corsa) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='5s'`);
    // Non cancellare nulla se sono comparsi dati estranei al test.
    const { rows: [check] } = await client.query(`
      SELECT (SELECT COUNT(*)::int FROM public.prenotazioni WHERE corsa_id=$1) AS bookings,
             (SELECT COUNT(*)::int FROM public.popbus_riserve WHERE corsa_id=$1
              AND (NOT (id=ANY($2::bigint[])) OR payment_intent_id IS NOT NULL
                   OR stato<>'riservata')) AS other_reservations,
             (SELECT COUNT(*)::int FROM public.popbus_attivazioni
              WHERE corsa_id=$1 AND id<>$3) AS other_activations`,
      [created.corsa,created.riserve,created.attivazione]);
    assert.equal(check.bookings, 0, 'STOP PULIZIA: prenotazioni inattese');
    assert.equal(check.other_reservations, 0, 'STOP PULIZIA: riserve inattese');
    assert.equal(check.other_activations, 0, 'STOP PULIZIA: attivazioni inattese');
    const deleted = await client.query(`DELETE FROM public.popbus_riserve
      WHERE corsa_id=$1 AND id=ANY($2::bigint[]) AND stato='riservata'
        AND payment_intent_id IS NULL RETURNING id`, [created.corsa,created.riserve]);
    await client.query('DELETE FROM public.popbus_attivazioni WHERE id=$1 AND corsa_id=$2',
      [created.attivazione,created.corsa]);
    const gone = await client.query(`DELETE FROM public.corse
      WHERE id=$1 AND origine_address=$2 RETURNING id`, [created.corsa,PREFIX]);
    assert.equal(gone.rowCount,1,'Fixture non eliminata');
    await client.query('COMMIT');
    log('PULIZIA OK: riserve', deleted.rowCount, 'corsa', created.corsa);
  } catch (e) {
    cleanupFailed = true;
    await client.query('ROLLBACK').catch(() => {});
    console.error('PULIZIA NON COMPLETATA. ID DA VERIFICARE:', JSON.stringify(created), 'marker:', PREFIX, e);
  } finally { client.release(); }
}

try {
  await prerequisites();
  if (!RUN) {
    log('DRY_RUN OK: nessuna scrittura eseguita.');
  } else {
    await createFixture();
    await test();
  }
} catch (e) {
  console.error('TEST FALLITO:', e);
  process.exitCode = 1;
} finally {
  if (RUN) await cleanup();
  if (cleanupFailed) process.exitCode = 1;
  await pool.end();
}
