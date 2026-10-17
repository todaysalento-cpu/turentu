// TURENTU — TEST CONCORRENZA NCC CON COMMIT REALE (SOLO DATABASE DI COLLAUDO)
// Copia in tests/test_ncc_concorrenza_commit.mjs
// Crea una corsa dedicata con 2 posti, COMMIT di A, verifica rifiuto di B e pulizia.
// NON usare su database operativo. Non contatta Stripe.
import { pool } from '../db/db.js';
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';

let a, b, observer;
let txA = false, txB = false, setupTx = false;
let rideId = null, trattaId = null;
let pass = 0, fail = 0, cleaned = false;
const marker = `TURENTU_TEST_COMMIT_${process.pid}_${Date.now()}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
  if (ok) pass++; else { fail++; throw new Error(message); }
}
const segments = () => ({ startIdx: 0, endIdx: 100, startOffset: 0, endOffset: 60000, tratta_id: trattaId });

try {
  a = await pool.connect();
  b = await pool.connect();
  observer = await pool.connect();
  await a.query('BEGIN'); setupTx = true;
  await a.query("SET LOCAL lock_timeout='5s'");
  await a.query("SET LOCAL statement_timeout='20s'");

  const v = await a.query(`
    SELECT v.id, t.euro_km FROM public.veicolo v
    JOIN LATERAL (
      SELECT euro_km FROM public.tariffe
      WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0
      ORDER BY id DESC LIMIT 1
    ) t ON true
    WHERE v.posti_totali >= 2 ORDER BY v.id LIMIT 1
  `);
  if (!v.rows.length) throw new Error('GAP: nessun veicolo con almeno 2 posti e tariffa standard');
  const u = await a.query('SELECT id FROM public.utente ORDER BY id LIMIT 1');
  if (!u.rows.length) throw new Error('GAP: nessun cliente per FK');
  const clienteId = u.rows[0].id;
  const dir = await a.query('SELECT direzione FROM public.corse_tratte ORDER BY id LIMIT 1');
  const direzione = dir.rows[0]?.direzione ?? 'andata';
  const departure = new Date(Date.now() + 30 * 86400000);
  const arrival = new Date(departure.getTime() + 90 * 60000);

  const ride = await a.query(`
    INSERT INTO public.corse
      (veicolo_id,start_datetime,arrivo_datetime,tipo_corsa,stato,
       posti_totali,posti_disponibili,posti_prenotati,
       distanza,km_avvicinamento,km_riposizionamento,
       prezzo_fisso,prenotazione_origine_id,origine_address)
    VALUES ($1,$2,$3,'condivisa','prenotabile',2,2,0,60,5,10,NULL,NULL,$4)
    RETURNING id
  `, [v.rows[0].id, departure, arrival, marker]);
  rideId = ride.rows[0].id;
  const tr = await a.query(`
    INSERT INTO public.corse_tratte
      (corsa_id,direzione,distanza_km,durata_secondi,
       partenza_prevista,arrivo_previsto,stato_temporale)
    VALUES ($1,$2,60,5400,$3,$4,'programmato') RETURNING id
  `, [rideId, direzione, departure, arrival]);
  trattaId = tr.rows[0].id;
  await a.query('COMMIT'); setupTx = false;
  console.log(`\nCorsa di prova ${rideId}, tratta ${trattaId}, capienza 2, marker ${marker}`);
  check(!!rideId && !!trattaId, 'Corsa e tratta di test create e confermate');

  await a.query('BEGIN'); txA = true;
  await b.query('BEGIN'); txB = true;
  await a.query("SET LOCAL lock_timeout='5s'");
  await b.query("SET LOCAL lock_timeout='12s'");
  await a.query("SET LOCAL statement_timeout='20s'");
  await b.query("SET LOCAL statement_timeout='20s'");

  const pa = await prenotaCorsa({id: rideId}, clienteId, 2, segments(), a);
  check(!!pa?.id, 'A prenota tutti e 2 i posti (non ancora COMMIT)');

  let bSettled = false;
  const bPromise = prenotaCorsa({id: rideId}, clienteId, 1, segments(), b)
    .then(value => { bSettled = true; return {value}; }, error => { bSettled = true; return {error}; });
  let waiting = false;
  for (let i=0; i<40; i++) {
    await sleep(100);
    const activity = await observer.query(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [b.processID]);
    if (activity.rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
    if (bSettled) break;
  }
  check(waiting && !bSettled, 'B attende il lock detenuto da A');

  await a.query('COMMIT'); txA = false;
  check(true, 'A esegue COMMIT');
  const resultB = await bPromise;
  check(!!resultB.error && /Capienza insufficiente/.test(resultB.error.message),
    'B riprende e viene rifiutato per capienza insufficiente');
  await b.query('ROLLBACK'); txB = false;

  const verified = await observer.query(`
    SELECT c.posti_totali,c.posti_prenotati,c.posti_disponibili,
      c.prezzo_fisso,c.prenotazione_origine_id,
      (SELECT COUNT(*)::int FROM public.prenotazioni p WHERE p.corsa_id=c.id) AS n,
      (SELECT COALESCE(SUM(posti_richiesti),0)::int FROM public.prenotazioni p WHERE p.corsa_id=c.id) AS posti
    FROM public.corse c WHERE c.id=$1 AND c.origine_address=$2
  `, [rideId, marker]);
  const state = verified.rows[0];
  check(!!state && Number(state.n) === 1 && Number(state.posti) === 2,
    'Dopo COMMIT rimane una sola prenotazione da 2 posti');
  check(Number(state.posti_disponibili) === 0 && Number(state.posti_prenotati) === 2,
    'Disponibilita zero, senza overbooking');
  check(Number(state.prezzo_fisso) > 0 && Number(state.prenotazione_origine_id) === Number(pa.id),
    'Snapshot Modello A persistito correttamente');

} catch (err) {
  console.error(`\nERRORE: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (a && (setupTx || txA)) {
    try { await a.query('ROLLBACK'); } catch(e) { console.error('ROLLBACK A:',e.message); process.exitCode=1; }
  }
  if (b && txB) {
    try { await b.query('ROLLBACK'); } catch(e) { console.error('ROLLBACK B:',e.message); process.exitCode=1; }
  }
  // Cleanup mirato: cancella SOLO la corsa con ID e marker creati dal test.
  if (rideId && observer) {
    let cleanupTx = false;
    try {
      await observer.query('BEGIN'); cleanupTx = true;
      await observer.query("SET LOCAL lock_timeout='5s'");
      await observer.query("SET LOCAL statement_timeout='20s'");
      const own = await observer.query(
        'SELECT id FROM public.corse WHERE id=$1 AND origine_address=$2 FOR UPDATE',
        [rideId, marker]);
      if (own.rows.length !== 1) throw new Error('Marker di sicurezza non trovato: cleanup sospeso');
      // Evita un possibile vincolo FK dal campo snapshot alla prenotazione origine.
      await observer.query('UPDATE public.corse SET prenotazione_origine_id=NULL WHERE id=$1', [rideId]);
      await observer.query('DELETE FROM public.prenotazioni WHERE corsa_id=$1', [rideId]);
      await observer.query('DELETE FROM public.corse_tratte WHERE corsa_id=$1', [rideId]);
      const deleted = await observer.query(
        'DELETE FROM public.corse WHERE id=$1 AND origine_address=$2 RETURNING id',
        [rideId, marker]);
      if (deleted.rows.length !== 1) throw new Error('Corsa non eliminata: rollback cleanup');
      await observer.query('COMMIT'); cleanupTx = false; cleaned = true;
      console.log(`PASS Cleanup confermato: corsa ${rideId} e dati associati rimossi`);
      pass++;
    } catch(e) {
      console.error(`ATTENZIONE: cleanup non riuscito: ${e.message}`);
      console.error(`RIMUOVERE MANUALMENTE SOLO DATI TEST: corsa_id=${rideId}, tratta_id=${trattaId}, marker=${marker}`);
      process.exitCode=1; fail++;
      if (cleanupTx) try { await observer.query('ROLLBACK'); } catch(_) {}
    }
  }
  a?.release(); b?.release(); observer?.release();
  await pool.end();
  console.log(`\nRISULTATO: ${pass} PASS, ${fail} FAIL. Cleanup: ${cleaned ? 'OK' : 'NON CONFERMATO'}`);
  console.log('Stripe non contattato. Sequenze PostgreSQL possono avanzare.');
}
