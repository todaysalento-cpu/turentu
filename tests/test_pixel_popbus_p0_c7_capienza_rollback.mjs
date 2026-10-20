/**
 * TURENTU / POPBUS V2 - P0-C7A
 * Contratto PostgreSQL capienza per missioni sequenziali.
 * SOLO database di collaudo; tutte le scritture sono transazionali e rollback.
 * Nessuna chiamata Stripe, HTTP, socket o acceptance.js.
 * Esecuzione CMD:
 *   set TURENTU_TEST_DB=1
 *   node tests\test_pixel_popbus_p0_c7_capienza_rollback.mjs
 *   set TURENTU_TEST_DB=
 */
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';

if (process.env.TURENTU_TEST_DB !== '1') {
  console.error('BLOCCATO: impostare TURENTU_TEST_DB=1 SOLO sul database di collaudo.');
  process.exit(2);
}

let client;
let tx = false;
try {
  client = await pool.connect();
  // Non avviare una transazione prima di verificare l'esistenza del trigger.
  const { rows: triggers } = await client.query(`
    SELECT t.tgname, p.proname
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.prenotazioni'::regclass
      AND t.tgname = 'trg_check_posti'
      AND p.proname = 'check_posti_disponibili_trigger'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  `);
  assert.equal(triggers.length, 1, 'Trigger di capienza attivo non trovato');

  // Riutilizza solo riferimenti FK gia' esistenti; non modifica i record originali.
  const { rows: vehicles } = await client.query(`
    SELECT id, posti_totali FROM public.veicolo
    WHERE posti_totali >= 4 ORDER BY posti_totali, id LIMIT 1
  `);
  const { rows: users } = await client.query(`
    SELECT id FROM public.utente ORDER BY id LIMIT 1
  `);
  assert.ok(vehicles.length, 'Nessun veicolo con almeno 4 posti nel DB di collaudo');
  assert.ok(users.length, 'Nessun utente nel DB di collaudo');
  const vehicle = vehicles[0];
  const capacity = Number(vehicle.posti_totali);
  const clientId = users[0].id;
  assert.ok(Number.isSafeInteger(capacity) && capacity >= 4);

  await client.query('BEGIN');
  tx = true;
  await client.query(`SET LOCAL statement_timeout = '15s'`);
  await client.query(`SET LOCAL lock_timeout = '3s'`);

  // Corse di test senza effetti esterni: tre intervalli disgiunti [0,10), [10,20), [20,30).
  const { rows: created } = await client.query(`
    INSERT INTO public.corse
      (veicolo_id, start_datetime, arrivo_datetime, tipo_corsa, stato,
       posti_totali, posti_disponibili, posti_prenotati,
       origine_address, destinazione_address)
    VALUES ($1, NOW() + INTERVAL '10 years', NOW() + INTERVAL '10 years 1 hour',
            'riempimento', 'prenotabile', $2, $2, 0,
            'P0-C7A TEST ORIGINE', 'P0-C7A TEST DESTINAZIONE')
    RETURNING id
  `, [vehicle.id, capacity]);
  const corsaId = created[0].id;

  async function book(seats, start, end) {
    const { rows } = await client.query(`
      INSERT INTO public.prenotazioni
        (corsa_id, cliente_id, posti_richiesti, posti_prenotati,
         start_offset, end_offset, start_index_polyline, end_index_polyline)
      VALUES ($1, $2, $3, $3, $4, $5, $6, $7)
      RETURNING id, posti_richiesti, start_offset, end_offset
    `, [corsaId, clientId, seats, start, end, start, end]);
    return rows[0];
  }

  const seats = [capacity - 2, capacity - 1, capacity - 3];
  const bookings = [
    await book(seats[0], 0, 10),
    await book(seats[1], 10, 20),
    await book(seats[2], 20, 30)
  ];
  assert.equal(bookings.length, 3);
  const total = seats.reduce((a, b) => a + b, 0);
  const peak = Math.max(...seats);
  assert.ok(total > capacity, 'Fixture non dimostra riutilizzo sequenziale');
  assert.ok(peak <= capacity);
  console.log(`PASS P0-C7A: 3 missioni sequenziali, ${total} posti trasportati, capienza ${capacity}, picco ${peak}.`);

  const { rows: check } = await client.query(`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(posti_richiesti),0)::int AS totale
    FROM public.prenotazioni WHERE corsa_id=$1
  `, [corsaId]);
  assert.equal(check[0].n, 3);
  assert.equal(check[0].totale, total);
  console.log('PASS P0-C7A: 3 prenotazioni persistite nella medesima corsa (solo nella transazione).');

  // Una prenotazione sovrapposta alla seconda missione porta il picco a capacita+1.
  await client.query('SAVEPOINT p0c7_over_capacity');
  let rejected = false;
  try {
    await book(2, 11, 19);
  } catch (error) {
    rejected = true;
    assert.match(String(error.message), /Capacita insufficiente/i,
      'Rifiuto inatteso: non proviene dal controllo del picco');
    console.log('PASS P0-C7A: sovrapposizione con picco superiore alla capienza rifiutata dal trigger.');
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT p0c7_over_capacity');
    await client.query('RELEASE SAVEPOINT p0c7_over_capacity');
  }
  assert.ok(rejected, 'Il trigger ha accettato una prenotazione oltre la capienza');

  const { rows: restored } = await client.query(`
    SELECT COUNT(*)::int AS n FROM public.prenotazioni WHERE corsa_id=$1
  `, [corsaId]);
  assert.equal(restored[0].n, 3);
  console.log('PASS P0-C7A: dopo il caso negativo restano le sole 3 prenotazioni valide.');

  // Prova che gli offset nulli/non crescenti sono respinti.
  await client.query('SAVEPOINT p0c7_bad_offset');
  let invalidRejected = false;
  try {
    await book(1, 25, 25);
  } catch (error) {
    invalidRejected = true;
    assert.match(String(error.message), /Offset prenotazione non validi/i);
    console.log('PASS P0-C7A: offset non crescente rifiutato.');
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT p0c7_bad_offset');
    await client.query('RELEASE SAVEPOINT p0c7_bad_offset');
  }
  assert.ok(invalidRejected, 'Offset non crescente accettato');
  console.log('PASS P0-C7A: verifiche completate; nessun COMMIT eseguito.');
} catch (error) {
  console.error('FAIL P0-C7A:', error);
  process.exitCode = 1;
} finally {
  if (client) {
    if (tx) {
      try { await client.query('ROLLBACK'); console.log('ROLLBACK eseguito.'); }
      catch (error) { console.error('ERRORE ROLLBACK:', error); process.exitCode = 1; }
    }
    client.release();
  }
  await pool.end();
}
