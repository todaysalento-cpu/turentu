// TURENTU — TEST NCC CONDIVISA MODELLO A SU POSTGRESQL REALE
// Eseguire rinominando questo file .mjs e mettendolo in tests/
// Tutte le modifiche DML sono nella stessa transazione, sempre ROLLBACK.
// Nessuna chiamata a Stripe o endpoint HTTP. Non eseguire in parallelo ad altri test.
import { pool } from '../db/db.js';
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';

const results = [];
const check = (ok, label, detail = '') => {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`Test fallito: ${label}${detail ? ` (${detail})` : ''}`);
};
const euros = v => Math.round(Number(v) * 100);
let client;
let began = false;
let rideId;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  began = true;
  // Evita attese illimitate in presenza di lock applicativi.
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '30s'");

  // Seleziona un veicolo reale con tariffa standard e almeno 3 posti.
  const v = await client.query(`
    SELECT v.id, v.posti_totali, t.euro_km
    FROM public.veicolo v
    JOIN LATERAL (
      SELECT euro_km FROM public.tariffe
      WHERE veicolo_id = v.id AND tipo = 'standard' AND euro_km > 0
      ORDER BY id DESC LIMIT 1
    ) t ON true
    WHERE v.posti_totali >= 3
    ORDER BY v.id LIMIT 1
  `);
  if (!v.rows.length) throw new Error('GAP: nessun veicolo con almeno 3 posti e tariffa standard valida');
  const vehicle = v.rows[0];

  // Riutilizza un utente reale soltanto come riferimento FK; nessuna sua riga viene modificata.
  const u = await client.query('SELECT id FROM public.utente ORDER BY id LIMIT 1');
  if (!u.rows.length) throw new Error('GAP: nessun utente per FK prenotazioni.cliente_id');
  const clienteId = u.rows[0].id;

  // La direzione deve rispettare i valori ammessi nello schema locale.
  const dir = await client.query('SELECT direzione FROM public.corse_tratte ORDER BY id LIMIT 1');
  const direzione = dir.rows[0]?.direzione ?? 'andata';
  const when = new Date(Date.now() + 30 * 86400000);
  const arrival = new Date(when.getTime() + 90 * 60000);

  const ride = await client.query(`
    INSERT INTO public.corse
      (veicolo_id, start_datetime, arrivo_datetime, tipo_corsa, stato,
       posti_totali, posti_disponibili, posti_prenotati,
       distanza, km_avvicinamento, km_riposizionamento,
       prezzo_fisso, prenotazione_origine_id)
    VALUES ($1,$2,$3,'condivisa','prenotabile',$4,$4,0,100,5,10,NULL,NULL)
    RETURNING id
  `, [vehicle.id, when, arrival, vehicle.posti_totali]);
  rideId = ride.rows[0].id;

  const tratta = await client.query(`
    INSERT INTO public.corse_tratte
      (corsa_id, direzione, distanza_km, durata_secondi,
       partenza_prevista, arrivo_previsto, stato_temporale)
    VALUES ($1,$2,100,5400,$3,$4,'programmato') RETURNING id
  `, [rideId, direzione, when, arrival]);
  const trattaId = tratta.rows[0].id;
  console.log(`\nTEST corsa temporanea ${rideId}, tratta ${trattaId}, veicolo ${vehicle.id}, tariffa ${vehicle.euro_km} €/km`);

  const snapshots = [];
  const segments = [
    { startIdx: 0, endIdx: 100, startOffset: 0, endOffset: 100000, tratta_id: trattaId },
    { startIdx: 10, endIdx: 70, startOffset: 10000, endOffset: 70000, tratta_id: trattaId },
    { startIdx: 30, endIdx: 90, startOffset: 30000, endOffset: 90000, tratta_id: trattaId },
  ];
  const ids = [];
  let fixedPrice;
  let firstId;

  for (let i = 0; i < 3; i++) {
    const p = await prenotaCorsa({ id: rideId }, clienteId, 1, segments[i], client);
    ids.push(p.id);
    const state = await client.query('SELECT prezzo_fisso, prenotazione_origine_id, posti_prenotati FROM public.corse WHERE id=$1', [rideId]);
    const bookings = await client.query('SELECT id, tratta_id, posti_richiesti, km_utente, prezzo_totale FROM public.prenotazioni WHERE corsa_id=$1 ORDER BY id', [rideId]);
    const s = state.rows[0];
    if (i === 0) { fixedPrice = Number(s.prezzo_fisso); firstId = p.id; }
    check(Number.isFinite(Number(s.prezzo_fisso)) && Number(s.prezzo_fisso) > 0, `Step ${i+1}: snapshot prezzo valido`);
    check(euros(s.prezzo_fisso) === euros(fixedPrice), `Step ${i+1}: prezzo commerciale congelato`);
    check(Number(s.prenotazione_origine_id) === Number(firstId), `Step ${i+1}: prenotazione origine invariata`);
    check(bookings.rows.length === i + 1, `Step ${i+1}: numero prenotazioni`);
    check(bookings.rows.every(b => Number(b.tratta_id) === Number(trattaId)), `Step ${i+1}: tratta coerente`);
    check(bookings.rows.every(b => Number.isFinite(Number(b.prezzo_totale)) && Number(b.prezzo_totale) >= 0), `Step ${i+1}: quote valorizzate`);
    check(Number(s.posti_prenotati) === i + 1, `Step ${i+1}: posti aggregati`);
    snapshots.push(bookings.rows.map(b => ({ id: Number(b.id), quota: Number(b.prezzo_totale) })));
    console.table(bookings.rows);
  }

  // Verifica la redistribuzione rispetto alla prima quota, senza assumere formule non viste.
  check(snapshots[0][0].quota >= snapshots[2][0].quota, 'Quota prima prenotazione non aumenta con nuovi passeggeri');
  check(snapshots[2].length === 3, 'Tre quote finali presenti');

  // Test capienza: richiesta sovradimensionata deve essere rifiutata e non inserita.
  const before = await client.query('SELECT count(*)::int AS n FROM public.prenotazioni WHERE corsa_id=$1', [rideId]);
  let capacityRejected = false;
  try {
    await prenotaCorsa({ id: rideId }, clienteId, Number(vehicle.posti_totali), segments[1], client);
  } catch (e) {
    capacityRejected = /Capienza insufficiente/.test(e.message);
    if (!capacityRejected) throw e;
  }
  check(capacityRejected, 'Capienza eccedente rifiutata');
  const after = await client.query('SELECT count(*)::int AS n FROM public.prenotazioni WHERE corsa_id=$1', [rideId]);
  check(before.rows[0].n === after.rows[0].n, 'Nessuna prenotazione aggiunta dopo rifiuto capienza');

  console.log('\nTUTTI I CONTROLLI ESEGUITI. Avvio ROLLBACK...');
} catch (e) {
  console.error('\nERRORE:', e.message);
  process.exitCode = 1;
} finally {
  if (client) {
    if (began) {
      try { await client.query('ROLLBACK'); console.log('ROLLBACK eseguito: dati di prova non persistiti.'); }
      catch (e) { console.error('ERRORE ROLLBACK:', e.message); process.exitCode = 1; }
    }
    client.release();
  }
  await pool.end();
  console.log(`RISULTATO: ${results.filter(r => r.ok).length} PASS, ${results.filter(r => !r.ok).length} FAIL`);
  console.log('Stripe non contattato. Nota: le sequenze PostgreSQL possono avanzare anche dopo ROLLBACK.');
}
