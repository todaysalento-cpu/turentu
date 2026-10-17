// TURENTU — CONCORRENZA NCC, SOLO DB DI COLLAUDO
// Copiare in tests/test_ncc_concorrenza.mjs
// Usa una corsa esistente, senza COMMIT: tutte le modifiche vengono annullate.
// Richiede corsa 899 ancora integra, senza prenotazioni e con tratta 3 programmata.
import { pool } from '../db/db.js';
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';

const CORSA_ID = 899;
const TRATTA_ID = 3;
let a, b, observer;
let txA = false, txB = false;
let passed = 0;
const check = (condition, label) => {
  if (!condition) throw new Error(`FAIL ${label}`);
  passed++;
  console.log(`PASS ${label}`);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const segmenti = { startIdx: 0, endIdx: 100, startOffset: 0, endOffset: 60000, tratta_id: TRATTA_ID };

try {
  a = await pool.connect();
  b = await pool.connect();
  observer = await pool.connect();

  // Controlli preliminari: non usare una corsa che nel frattempo e' cambiata.
  const q = await observer.query(`
    SELECT c.id, c.stato, c.tipo_corsa, c.posti_totali,
           c.prezzo_fisso, c.prenotazione_origine_id,
           t.id AS tratta_id, t.partenza_prevista,
           t.stato_temporale,
           (SELECT count(*)::int FROM public.prenotazioni p WHERE p.corsa_id=c.id) AS prenotazioni,
           (SELECT count(*)::int FROM public.tariffe tf
              WHERE tf.veicolo_id=c.veicolo_id AND tf.tipo='standard' AND tf.euro_km>0) AS tariffe
    FROM public.corse c
    JOIN public.corse_tratte t ON t.corsa_id=c.id AND t.id=$2
    WHERE c.id=$1
  `, [CORSA_ID, TRATTA_ID]);
  const c = q.rows[0];
  if (!c || c.stato !== 'prenotabile' || c.tipo_corsa !== 'condivisa' ||
      Number(c.posti_totali) < 2 || Number(c.prenotazioni) !== 0 ||
      c.prezzo_fisso !== null || c.prenotazione_origine_id !== null ||
      !c.partenza_prevista || c.stato_temporale === 'flessibile' ||
      Number(c.tariffe) === 0) {
    throw new Error('GAP: corsa 899 / tratta 3 non piu idonea. Nessuna modifica effettuata.');
  }
  const user = await observer.query('SELECT id FROM public.utente ORDER BY id LIMIT 1');
  if (!user.rows.length) throw new Error('GAP: nessun utente per FK');
  const clienteId = user.rows[0].id;
  check(true, 'Preflight corsa e tratta idonee');

  await a.query('BEGIN'); txA = true;
  await b.query('BEGIN'); txB = true;
  await a.query("SET LOCAL lock_timeout='5s'");
  await b.query("SET LOCAL lock_timeout='12s'");
  await a.query("SET LOCAL statement_timeout='20s'");
  await b.query("SET LOCAL statement_timeout='20s'");

  // A prenota e trattiene il lock di riga fino al rollback.
  const pa = await prenotaCorsa({id: CORSA_ID}, clienteId, 1, segmenti, a);
  check(!!pa?.id, 'Connessione A prenota nella propria transazione');

  // B parte senza essere attesa: dovrebbe fermarsi sul FOR UPDATE della corsa.
  let bSettled = false;
  const pbPromise = prenotaCorsa({id: CORSA_ID}, clienteId, 1, segmenti, b)
    .then(value => { bSettled = true; return value; }, error => { bSettled = true; throw error; });
  // Evita rejection non gestite mentre controlliamo pg_stat_activity.
  pbPromise.catch(() => {});

  let waitingOnLock = false;
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const activity = await observer.query(
      `SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid=$1`,
      [b.processID]
    );
    if (activity.rows[0]?.wait_event_type === 'Lock') { waitingOnLock = true; break; }
    if (bSettled) break;
  }
  check(waitingOnLock && !bSettled, 'Connessione B attende il lock della corsa');

  // Annulliamo A: B deve poter riprendere e prenotare.
  await a.query('ROLLBACK'); txA = false;
  const pb = await pbPromise;
  check(!!pb?.id, 'Connessione B riprende dopo il ROLLBACK di A');
  const withinB = await b.query('SELECT count(*)::int AS n FROM public.prenotazioni WHERE corsa_id=$1', [CORSA_ID]);
  check(Number(withinB.rows[0].n) === 1, 'B vede solo la propria prenotazione');

  await b.query('ROLLBACK'); txB = false;
  const after = await observer.query(`
    SELECT (SELECT count(*)::int FROM public.prenotazioni WHERE corsa_id=$1) AS n,
           prezzo_fisso, prenotazione_origine_id
    FROM public.corse WHERE id=$1
  `, [CORSA_ID]);
  check(Number(after.rows[0].n) === 0 && after.rows[0].prezzo_fisso === null &&
        after.rows[0].prenotazione_origine_id === null,
        'Entrambe le transazioni annullate, nessuna prenotazione persistita');
  console.log(`\nRISULTATO: ${passed} PASS, 0 FAIL`);
} catch (err) {
  console.error(`\nERRORE: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (a && txA) { try { await a.query('ROLLBACK'); } catch(e) { console.error('ROLLBACK A:',e.message); process.exitCode=1; } }
  if (b && txB) { try { await b.query('ROLLBACK'); } catch(e) { console.error('ROLLBACK B:',e.message); process.exitCode=1; } }
  a?.release(); b?.release(); observer?.release();
  await pool.end();
  console.log('Nessun COMMIT e nessuna chiamata Stripe.');
}
