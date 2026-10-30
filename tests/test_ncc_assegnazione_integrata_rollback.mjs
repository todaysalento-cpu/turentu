/**
 * Turentu — collaudo integrato NCC ROLLBACK_ONLY.
 * Copiare in tests/test_ncc_assegnazione_integrata_rollback.mjs.
 * Eseguire dalla root: node tests/test_ncc_assegnazione_integrata_rollback.mjs
 * Non chiama HTTP/Stripe; il routing esterno puo' essere chiamato dai servizi.
 * Richiede DB di test/staging: NON eseguire sul database di produzione.
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../db/db.js';
import { createCorsaFromPending } from '../services/corsa/corsa.service.js';
import { assegnaConducente } from '../services/conducenti/assegnazioni.service.js';

const OPERATORE_ID = 2;
const VEICOLO_ID = 366;
const CONDUCENTE_ID = 101;
const assert = (ok, message) => { if (!ok) throw new Error(`ASSERT: ${message}`); };
const iso = value => new Date(value).toISOString();
const timeInRome = date => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).format(date);
const weekdayInRome = date => new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Rome', weekday: 'short'
}).format(date);

// Costruisce un lunedi' futuro alle 11:00 locali, senza assumere offset CET/CEST.
function nextMondayRomeAt11() {
  const now = new Date();
  for (let days = 2; days < 30; days++) {
    const probe = new Date(now.getTime() + days * 86400000);
    const dateText = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(probe);
    const parts = dateText.match(/(\d{4})\D(\d{2})\D(\d{2})/);
    assert(parts, 'impossibile ricavare data locale Roma');
    const [, y, m, d] = parts;
    // 11:00 Europe/Rome e' 09:00 o 10:00 UTC; scegliamo in base all'ora locale.
    for (const utcHour of [9, 10]) {
      const candidate = new Date(`${y}-${m}-${d}T${String(utcHour).padStart(2, '0')}:00:00.000Z`);
      if (weekdayInRome(candidate) === 'Mon' && timeInRome(candidate) === '11:00') return candidate;
    }
  }
  throw new Error('Impossibile trovare un lunedi futuro alle 11:00 Europe/Rome');
}

let client;
let begun = false;
let corsaId = null;
let clienteId = null;
let assegnazioneId = null;
let passed = false;
let rollbackDone = false;
try {
  assert(process.env.NCC_TEST_ROLLBACK_ONLY === '1',
    'impostare NCC_TEST_ROLLBACK_ONLY=1 per confermare il collaudo');
  client = await pool.connect();
  await client.query('BEGIN');
  begun = true;
  await client.query("SET LOCAL statement_timeout = '90000ms'");
  await client.query("SET LOCAL lock_timeout = '5000ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '120000ms'");

  const vRes = await client.query(`
    SELECT v.id, v.driver_id AS operatore_id, v.posti_totali,
           ST_Y(v.coord::geometry) AS lat_base,
           ST_X(v.coord::geometry) AS lon_base
    FROM public.veicolo v WHERE v.id = $1`, [VEICOLO_ID]);
  const v = vRes.rows[0];
  assert(v, 'veicolo 366 assente');
  assert(Number(v.operatore_id) === OPERATORE_ID, 'veicolo non appartenente all operatore 2');
  assert(Number(v.posti_totali) >= 1, 'capienza veicolo non valida');
  assert(Number.isFinite(Number(v.lat_base)) && Number.isFinite(Number(v.lon_base)), 'base non valida');

  const driver = await client.query(`
    SELECT id FROM public.conducenti_operatori
    WHERE operatore_id=$1 AND conducente_id=$2 AND stato='attivo' LIMIT 1`,
    [OPERATORE_ID, CONDUCENTE_ID]);
  assert(driver.rowCount === 1, 'conducente non attivo per operatore');

  const start = nextMondayRomeAt11();
  const baseLat = Number(v.lat_base);
  const baseLon = Number(v.lon_base);
  // Piccola tratta vicina alla base, ma NON coincidente con essa.
  // Il routing reale deve confermarne la percorribilita'.
  const origineLat = baseLat + 0.004;
  const origineLon = baseLon + 0.003;
  const destinazioneLat = baseLat + 0.011;
  const destinazioneLon = baseLon + 0.010;

  const email = `turentu-ncc-rollback-${randomUUID()}@example.invalid`;
  const user = await client.query(`
    INSERT INTO public.utente (nome, email, tipo, password)
    VALUES ('TURENTU_TEST_ROLLBACK', $1, 'cliente', 'NO_LOGIN_TEST_ONLY')
    RETURNING id`, [email]);
  clienteId = Number(user.rows[0].id);
  console.log('PASS cliente sintetico', clienteId);

  const pending = {
    id: -1, // riferimento diagnostico: non viene inserita una riga pending
    cliente_id: clienteId,
    veicolo_id: VEICOLO_ID,
    tipo_corsa: 'condivisa',
    start_datetime: start.toISOString(),
    durataMinuti: 20,
    origine_lat: origineLat,
    origine_lon: origineLon,
    destinazione_lat: destinazioneLat,
    destinazione_lon: destinazioneLon,
    origine_address: 'TURENTU TEST - origine sintetica',
    destinazione_address: 'TURENTU TEST - destinazione sintetica',
    posti_richiesti: 1
  };
  const corsa = await createCorsaFromPending(pending, {
    id: VEICOLO_ID,
    posti_totali: Number(v.posti_totali),
    posti: Number(v.posti_totali),
    lat_base: baseLat,
    lon_base: baseLon
  }, client, false);
  corsaId = Number(corsa?.id);
  assert(Number.isSafeInteger(corsaId) && corsaId > 0, 'corsa non creata');

  const ride = (await client.query(`
    SELECT id, stato, tipo_corsa, inizio_ciclo_operativo, fine_ciclo_operativo,
           km_avvicinamento, km_riposizionamento
    FROM public.corse WHERE id=$1`, [corsaId])).rows[0];
  assert(ride?.stato === 'prenotabile' && ride?.tipo_corsa === 'condivisa', 'stato/tipo corsa errato');
  assert(ride.inizio_ciclo_operativo && ride.fine_ciclo_operativo, 'ciclo operativo non persistito');
  assert(new Date(ride.inizio_ciclo_operativo) < new Date(ride.fine_ciclo_operativo), 'ciclo non crescente');
  assert(Number(ride.km_riposizionamento) > 0, 'rientro commerciale mancante');
  assert(weekdayInRome(ride.inizio_ciclo_operativo) === 'Mon' && weekdayInRome(ride.fine_ciclo_operativo) === 'Mon',
    'ciclo non interamente lunedi Europe/Rome');
  assert(timeInRome(ride.inizio_ciclo_operativo) >= '08:00' && timeInRome(ride.fine_ciclo_operativo) <= '16:00',
    'ciclo operativo fuori turno 08:00-16:00 Europe/Rome');
  console.log('PASS ciclo operativo', iso(ride.inizio_ciclo_operativo), iso(ride.fine_ciclo_operativo));

  const tratte = (await client.query(`
    SELECT direzione, stato_temporale, prima_prenotazione_id
    FROM public.corse_tratte WHERE corsa_id=$1 ORDER BY id`, [corsaId])).rows;
  assert(tratte.length === 2, 'attese esattamente due tratte');
  const andata = tratte.find(t => t.direzione === 'andata');
  const ritorno = tratte.find(t => t.direzione === 'ritorno');
  assert(andata?.stato_temporale === 'programmato' && andata.prima_prenotazione_id,
    'andata/prima prenotazione non valida');
  assert(ritorno?.stato_temporale === 'flessibile' && !ritorno.prima_prenotazione_id,
    'ritorno non flessibile o gia prenotato');
  const prenotazioneId = Number(andata.prima_prenotazione_id);
  // Verifica referenziale tramite identificativo; il modello economico si verifica
  // solo se e' possibile identificarne in modo certo i campi.
  const booking = await client.query('SELECT * FROM public.prenotazioni WHERE id=$1', [prenotazioneId]);
  assert(booking.rowCount === 1, 'prima prenotazione non trovata');
  const b = booking.rows[0];
  assert(Number(b.corsa_id) === corsaId, 'prenotazione associata ad altra corsa');
  if ('cliente_id' in b) assert(Number(b.cliente_id) === clienteId, 'cliente prenotazione errato');
  console.log('PASS corsa/tratte/prenotazione', { corsaId, prenotazioneId });

  const assignment = await assegnaConducente(client, {
    operatoreId: OPERATORE_ID,
    veicoloId: VEICOLO_ID,
    corsaId,
    modalita: 'manuale',
    conducenteId: CONDUCENTE_ID,
    usaCicloPersistito: true
  });
  assegnazioneId = Number(assignment?.id);
  assert(Number.isSafeInteger(assegnazioneId) && assegnazioneId > 0, 'assegnazione non creata');
  const ar = (await client.query('SELECT * FROM public.assegnazioni_conducenti WHERE id=$1', [assegnazioneId])).rows[0];
  assert(ar, 'assegnazione non persistita nella transazione');
  assert(Number(ar.conducente_id) === CONDUCENTE_ID, 'conducente assegnato errato');
  assert(Number(ar.veicolo_id) === VEICOLO_ID, 'veicolo assegnato errato');
  assert(Number(ar.corsa_id) === corsaId, 'corsa assegnata errata');
  // L'intervallo operativo e' un range PostgreSQL: confronta lower/upper.
  const bounds = (await client.query(`
    SELECT lower(intervallo_operativo) AS inizio,
           upper(intervallo_operativo) AS fine
    FROM public.assegnazioni_conducenti WHERE id=$1`, [assegnazioneId])).rows[0];
  assert(bounds?.inizio && bounds?.fine, 'intervallo operativo assegnazione mancante');
  assert(iso(bounds.inizio) === iso(ride.inizio_ciclo_operativo), 'inizio assegnazione diverso dal ciclo');
  assert(iso(bounds.fine) === iso(ride.fine_ciclo_operativo), 'fine assegnazione diversa dal ciclo');
  console.log('PASS assegnazione fisica', assegnazioneId);
  passed = true;
} catch (err) {
  console.error('FAIL test NCC:', err?.stack || err);
} finally {
  if (client) {
    if (begun) {
      try {
        await client.query('ROLLBACK');
        rollbackDone = true;
        console.log('ROLLBACK eseguito');
      } catch (e) {
        console.error('ERRORE CRITICO rollback:', e);
        passed = false;
      }
    }
    // Dopo rollback, verifica tramite nuova query sulla stessa connessione.
    if (rollbackDone) {
      try {
        for (const [table, id] of [
          ['utente', clienteId], ['corse', corsaId], ['assegnazioni_conducenti', assegnazioneId]
        ]) {
          if (!id) continue;
          const check = await client.query(`SELECT 1 FROM public.${table} WHERE id=$1`, [id]);
          assert(check.rowCount === 0, `residuo dopo rollback in ${table}: ${id}`);
        }
        console.log('PASS assenza righe di prova dopo rollback');
      } catch (e) {
        passed = false;
        console.error('FAIL verifica post-rollback:', e?.message || e);
      }
    }
    client.release(!rollbackDone);
  }
  await pool.end();
}
if (!rollbackDone) passed = false;
console.log(passed ? 'ESITO: PASS ROLLBACK_ONLY' : 'ESITO: FAIL ROLLBACK_ONLY');
process.exitCode = passed ? 0 : 1;
