/**
 * TURENTU POPBUS P0-E2D — TEST REALE DELLA MIGRAZIONE, SOLO ROLLBACK
 * Salva in tests/test_popbus_P0E2D_trigger_capacity_rollback.mjs
 * Metti la migrazione SQL nella stessa cartella tests/.
 * node tests/test_popbus_P0E2D_trigger_capacity_rollback.mjs
 * Esegue CREATE FUNCTION/DROP+CREATE TRIGGER soltanto DENTRO una transazione
 * che viene SEMPRE annullata. Nessun COMMIT; nessuna chiamata Stripe.
 */
import { pool } from '../db/db.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sqlFile = join(here, 'P0E2D_migrazione_trigger_capacita.sql');
const migration = readFileSync(sqlFile, 'utf8')
  .replace(/^\s*BEGIN\s*;/im, '')
  .replace(/^\s*COMMIT\s*;/im, '');
let pass = 0, fail = 0, warn = 0;
const report = (kind, message) => {
  console.log(`${kind} ${message}`);
  if (kind === 'PASS') pass++;
  else if (kind === 'FAIL') fail++;
  else warn++;
};
const check = (ok, message) => { report(ok ? 'PASS' : 'FAIL', message); if (!ok) throw new Error(message); };
const message = e => String(e?.message || e).replace(/\s+/g, ' ').slice(0, 180);
const negative = () => -(1300000000 + Math.floor(Math.random() * 500000000));
let db, began = false, rideId, fixtureCreated = false;

async function booking(id, customer, seats, start, end) {
  return db.query(`INSERT INTO public.prenotazioni
    (id, corsa_id, cliente_id, posti_prenotati, posti_richiesti, start_offset, end_offset)
    VALUES ($1,$2,$3,$4,$4,$5,$6)`, [id, rideId, customer, seats, start, end]);
}
async function rejected(label, fn, fragment = 'Capacita') {
  await db.query('SAVEPOINT p0e2d_probe');
  let error;
  try { await fn(); } catch (e) { error = e; }
  await db.query('ROLLBACK TO SAVEPOINT p0e2d_probe');
  await db.query('RELEASE SAVEPOINT p0e2d_probe');
  check(Boolean(error) && message(error).includes(fragment), `${label}${error ? ` (${message(error)})` : ''}`);
}
async function accepted(label, fn) { await fn(); report('PASS', label); }

console.log('=== TURENTU POPBUS P0-E2D — MIGRAZIONE IN TRANSAZIONE / ROLLBACK ===');
console.log('Nessun COMMIT, nessuna chiamata Stripe, nessuna modifica permanente.');
try {
  check(!/^\s*(?:BEGIN|COMMIT)\s*;/im.test(migration), 'SQL migration privata dei delimitatori transazionali');
  db = await pool.connect();
  await db.query('BEGIN'); began = true;
  await db.query("SET LOCAL lock_timeout = '3000ms'");
  await db.query("SET LOCAL statement_timeout = '15000ms'");
  await db.query("SET LOCAL idle_in_transaction_session_timeout = '45000ms'");

  const oldTrigger = await db.query(`SELECT pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='prenotazioni'
      AND t.tgname='trg_check_posti' AND NOT t.tgisinternal`);
  check(oldTrigger.rowCount === 1, 'Trigger originale presente');
  check(/BEFORE INSERT/i.test(oldTrigger.rows[0].definition), 'Trigger originale protegge INSERT');

  await db.query(migration);
  report('PASS', 'Migrazione applicata dentro la transazione di test');
  const newTrigger = await db.query(`SELECT pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='prenotazioni'
      AND t.tgname='trg_check_posti' AND NOT t.tgisinternal`);
  check(newTrigger.rowCount === 1 && /BEFORE INSERT OR UPDATE/i.test(newTrigger.rows[0].definition),
    'Trigger temporaneo protegge INSERT e UPDATE');

  const vehicle = await db.query('SELECT id FROM public.veicolo ORDER BY id LIMIT 1');
  const user = await db.query('SELECT id FROM public.utente ORDER BY id LIMIT 1');
  check(vehicle.rowCount === 1 && user.rowCount === 1, 'Veicolo e utente esistenti trovati');
  const userId = user.rows[0].id;
  rideId = negative();
  const base = negative();
  const ids = [base, base-1, base-2, base-3, base-4, base-5];
  const collision = await db.query(`SELECT
    EXISTS(SELECT 1 FROM public.corse WHERE id=$1) AS ride,
    EXISTS(SELECT 1 FROM public.prenotazioni WHERE id=ANY($2::integer[])) AS booking`, [rideId, ids]);
  check(!collision.rows[0].ride && !collision.rows[0].booking, 'ID sintetici senza collisioni');
  const date = new Date(Date.now() + 730 * 86400000 + Math.floor(Math.random() * 86400000));
  await db.query(`INSERT INTO public.corse
    (id, veicolo_id, start_datetime, tipo_corsa, stato, posti_totali, posti_disponibili,
     posti_prenotati, origine_address, destinazione_address)
    VALUES ($1,$2,$3,'condivisa','da_attivare',4,4,0,'P0-E2D TEST','P0-E2D TEST')`,
    [rideId, vehicle.rows[0].id, date]);
  fixtureCreated = true;
  report('PASS', 'Corsa sintetica 4 posti creata nella transazione');

  await accepted('INSERT missione 1 [0,10) 4 posti', () => booking(ids[0], userId, 4, 0, 10));
  await accepted('INSERT missione 2 [10,20) 4 posti', () => booking(ids[1], userId, 4, 10, 20));
  await rejected('INSERT sovrapposto [5,15) respinto', () => booking(ids[2], userId, 1, 5, 15));
  await rejected('UPDATE start_offset sovrapposto respinto', () => db.query(
    'UPDATE public.prenotazioni SET start_offset=5 WHERE id=$1', [ids[1]]));
  await rejected('UPDATE end_offset sovrapposto respinto', () => db.query(
    'UPDATE public.prenotazioni SET end_offset=15 WHERE id=$1', [ids[0]]));
  await rejected('UPDATE posti_richiesti oltre capacita respinto', () => db.query(
    'UPDATE public.prenotazioni SET posti_richiesti=5 WHERE id=$1', [ids[1]]));
  await rejected('UPDATE indici invertiti respinto', () => db.query(
    'UPDATE public.prenotazioni SET start_offset=25 WHERE id=$1', [ids[1]]), 'indici prenotazione non validi');
  await accepted('UPDATE innocuo su stessa tratta accettato (senza doppio conteggio)', () => db.query(
    'UPDATE public.prenotazioni SET start_offset=10 WHERE id=$1', [ids[1]]));
  await accepted('UPDATE riduzione posti accettato', () => db.query(
    'UPDATE public.prenotazioni SET posti_richiesti=3 WHERE id=$1', [ids[1]]));
  await accepted('INSERT in posti liberati accettato', () => booking(ids[2], userId, 1, 10, 20));
  await rejected('UPDATE incremento con capacita esaurita respinto', () => db.query(
    'UPDATE public.prenotazioni SET posti_richiesti=4 WHERE id=$1', [ids[1]]));
  const rows = await db.query(`SELECT id, start_offset, end_offset, posti_richiesti
    FROM public.prenotazioni WHERE corsa_id=$1 ORDER BY start_offset, id`, [rideId]);
  check(rows.rowCount === 3, 'Tre prenotazioni valide dopo i tentativi rifiutati');
  const wrong = rows.rows.some(r => Number(r.start_offset) === 5 || Number(r.posti_richiesti) === 5);
  check(!wrong, 'Nessuna modifica invalida persiste nella transazione');
} catch (e) {
  report('FAIL', `Test interrotto: ${message(e)}`);
} finally {
  if (db) {
    if (began) {
      try { await db.query('ROLLBACK'); report('PASS', 'ROLLBACK finale eseguito'); }
      catch (e) { report('FAIL', `ROLLBACK non riuscito: ${message(e)}`); }
    }
    db.release();
  }
  if (fixtureCreated) {
    try {
      const ride = await pool.query('SELECT 1 FROM public.corse WHERE id=$1', [rideId]);
      check(ride.rowCount === 0, 'Fixture assente dopo ROLLBACK');
      const trigger = await pool.query(`SELECT pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='prenotazioni'
          AND t.tgname='trg_check_posti' AND NOT t.tgisinternal`);
      check(trigger.rowCount === 1 && /BEFORE INSERT/i.test(trigger.rows[0].definition)
        && !/UPDATE OF/i.test(trigger.rows[0].definition),
        'Trigger originale ripristinato dal ROLLBACK');
    } catch (e) { report('FAIL', `Verifica post-ROLLBACK: ${message(e)}`); }
  }
  await pool.end();
  console.log(`ESITO: ${pass} PASS, ${fail} FAIL, ${warn} WARN.`);
  if (fail) process.exitCode = 1;
}
