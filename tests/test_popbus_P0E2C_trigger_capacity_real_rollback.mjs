/**
 * TURENTU POPBUS — P0-E2C
 * Test reale PostgreSQL del trigger di capacità, transazione ROLLBACK.
 * Salvare come tests/test_popbus_P0E2C_trigger_capacity_real_rollback.mjs
 * Avviare: node tests/test_popbus_P0E2C_trigger_capacity_real_rollback.mjs
 * Nessuna chiamata Stripe, nessun COMMIT, nessuna modifica al codice applicativo.
 * Richiede un veicolo e un utente già presenti nel DB di TEST.
 */
import { pool } from '../db/db.js';

const TAG = 'P0-E2C';
let pass = 0, fail = 0, warn = 0;
const log = (kind, msg) => { console.log(`${kind} ${msg}`); if (kind === 'PASS') pass++; else if (kind === 'FAIL') fail++; else warn++; };
const assert = (condition, msg) => log(condition ? 'PASS' : 'FAIL', msg);
const errText = e => String(e?.message || e).replace(/\s+/g, ' ').slice(0, 240);
const randomNegative = () => -(1000000000 + Math.floor(Math.random() * 100000000));

let client;
let corsaId;
let transactionStarted = false;
let inserted = false;
let runError = false;

async function insertBooking(id, clienteId, seats, start, end) {
  await client.query(`
    INSERT INTO public.prenotazioni
      (id, corsa_id, cliente_id, posti_prenotati, posti_richiesti, start_offset, end_offset)
    VALUES ($1,$2,$3,$4,$4,$5,$6)
  `, [id, corsaId, clienteId, seats, start, end]);
}

async function expectRejection(label, operation, expectedText = 'Capacit') {
  const savepoint = 'p0e2c_probe';
  await client.query(`SAVEPOINT ${savepoint}`);
  let rejected = false, actual = '';
  try {
    await operation();
  } catch (e) {
    rejected = true;
    actual = errText(e);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
  assert(rejected && actual.includes(expectedText), `${label}${rejected ? ` (${actual})` : ' (nessun errore)'}`);
}

console.log('=== TURENTU POPBUS P0-E2C — TRIGGER CAPACITÀ / DB REALE / ROLLBACK ===');
console.log('MODALITÀ: DB DI TEST; nessun COMMIT; nessuna chiamata Stripe.');
try {
  client = await pool.connect();
  await client.query('BEGIN');
  transactionStarted = true;
  await client.query("SET LOCAL statement_timeout = '12000ms'");
  await client.query("SET LOCAL lock_timeout = '2000ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '30000ms'");

  // Verifica che il trigger sia installato e attivo. Non disabilitarlo mai.
  const trig = await client.query(`
    SELECT t.tgenabled, pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='prenotazioni'
      AND t.tgname='trg_check_posti' AND NOT t.tgisinternal
  `);
  const triggerOK = trig.rowCount === 1 && trig.rows[0].tgenabled === 'O'
    && /BEFORE INSERT/i.test(trig.rows[0].definition);
  assert(triggerOK, 'Trigger trg_check_posti attivo su BEFORE INSERT');
  if (!triggerOK) throw new Error('Trigger non attivo: test interrotto');

  const [vehicle, user] = await Promise.all([
    client.query('SELECT id FROM public.veicolo ORDER BY id LIMIT 1'),
    client.query('SELECT id FROM public.utente ORDER BY id LIMIT 1'),
  ]);
  if (!vehicle.rowCount || !user.rowCount) {
    log('WARN', 'Nessun veicolo o utente esistente: impossibile creare fixture senza dati aggiuntivi');
    throw new Error('Fixture non disponibile');
  }
  const vehicleId = vehicle.rows[0].id;
  const userId = user.rows[0].id;
  assert(true, 'Veicolo e utente di riferimento presenti (non modificati)');

  // ID negativi espliciti: NON consumiamo le sequenze PostgreSQL (che non sono transazionali).
  corsaId = randomNegative();
  const base = randomNegative();
  const ids = [base, base-1, base-2, base-3, base-4, base-5];
  const collision = await client.query(`
    SELECT EXISTS(SELECT 1 FROM public.corse WHERE id=$1) AS corsa,
           EXISTS(SELECT 1 FROM public.prenotazioni WHERE id=ANY($2::integer[])) AS prenotazione
  `, [corsaId, ids]);
  if (collision.rows[0].corsa || collision.rows[0].prenotazione) throw new Error('Collisione ID fixture: rieseguire');

  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 730 + Math.floor(Math.random()*86400000));
  await client.query(`
    INSERT INTO public.corse
      (id, veicolo_id, start_datetime, tipo_corsa, stato, posti_totali, posti_disponibili,
       posti_prenotati, origine_address, destinazione_address)
    VALUES ($1,$2,$3,'condivisa','da_attivare',4,4,0,'P0-E2C TEST','P0-E2C TEST')
  `, [corsaId, vehicleId, future]);
  inserted = true;
  assert(true, 'Corsa sintetica da 4 posti inserita nella transazione');

  // Missione 1: 4 posti occupati su [0, 10).
  await insertBooking(ids[0], userId, 4, 0, 10);
  assert(true, 'Missione 1: quattro posti [0,10) accettati');

  // Missione 2: stessa capacità su [10, 20), senza sovrapposizione.
  await insertBooking(ids[1], userId, 4, 10, 20);
  assert(true, 'Missione 2: quattro posti [10,20) accettati (riutilizzo capacità)');

  await expectRejection('Sovrapposizione [5,15) rifiutata',
    () => insertBooking(ids[2], userId, 1, 5, 15));
  await expectRejection('Superamento capacità [0,10) rifiutato',
    () => insertBooking(ids[3], userId, 1, 0, 10));
  await expectRejection('Offset invertiti rifiutati',
    () => insertBooking(ids[4], userId, 1, 22, 21), 'indici prenotazione non validi');

  const count = await client.query('SELECT COUNT(*)::integer AS n FROM public.prenotazioni WHERE corsa_id=$1', [corsaId]);
  assert(count.rows[0].n === 2, 'Dopo i rifiuti restano solo le due prenotazioni valide');

  // Il trigger è solo BEFORE INSERT: proviamo un UPDATE che viola la capacità.
  // L'UPDATE è annullato con SAVEPOINT immediatamente dopo la prova.
  await client.query('SAVEPOINT p0e2c_update');
  let updateAllowed = false;
  let updateError = '';
  try {
    await client.query('UPDATE public.prenotazioni SET start_offset=5 WHERE id=$1', [ids[1]]);
    updateAllowed = true;
  } catch (e) { updateError = errText(e); }
  await client.query('ROLLBACK TO SAVEPOINT p0e2c_update');
  await client.query('RELEASE SAVEPOINT p0e2c_update');
  if (updateAllowed) log('WARN', 'GAP CONFERMATO: UPDATE può creare sovrapposizione senza controllo del trigger');
  else log('PASS', `UPDATE bloccato da altra protezione (${updateError})`);

  const columns = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='prenotazioni' AND column_name='stato'
  `);
  if (!columns.rowCount) log('WARN', 'prenotazioni non ha colonna stato: impossibile escludere annullate tramite stato nella funzione attuale');
  else log('WARN', 'Colonna stato presente: verifica cancellazioni da integrare');

} catch (e) {
  runError = true;
  log('FAIL', `Test interrotto: ${errText(e)}`);
} finally {
  if (client) {
    if (transactionStarted) {
      try { await client.query('ROLLBACK'); assert(true, 'ROLLBACK finale eseguito'); }
      catch (e) { log('FAIL', `ROLLBACK fallito: ${errText(e)}`); }
    }
    client.release();
  }
  // Verifica da una NUOVA connessione che la fixture non sia rimasta nel database.
  if (inserted && corsaId != null) {
    try {
      const result = await pool.query('SELECT COUNT(*)::integer AS n FROM public.corse WHERE id=$1', [corsaId]);
      assert(result.rows[0].n === 0, 'Corsa sintetica assente dopo ROLLBACK');
    } catch (e) { log('FAIL', `Verifica pulizia fallita: ${errText(e)}`); }
  }
  await pool.end();
  console.log(`ESITO: ${pass} PASS, ${fail} FAIL, ${warn} WARN. ${runError ? 'ESECUZIONE INTERROTTA.' : 'TEST TERMINATO.'}`);
  if (warn) console.log('WARN = rischi o limiti da approfondire, non equivalgono a PASS.');
  process.exitCode = fail ? 1 : 0;
}
