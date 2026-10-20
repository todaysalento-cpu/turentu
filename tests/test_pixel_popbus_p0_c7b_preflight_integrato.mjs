/**
 * TURENTU P0-C7B - preflight integrato READ ONLY per opportunita PIXEL 115/117.
 * Nessun INSERT/UPDATE, nessuna chiamata Stripe, nessuna modifica a produzione.
 * Uso: node tests\test_pixel_popbus_p0_c7b_preflight_integrato.mjs
 */
import { pool } from '../db/db.js';

const IDS = [115, 117];
const client = await pool.connect();
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'ATTENZIONE'}: ${label}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures++;
};
const iso = v => v == null ? 'NULL' : new Date(v).toISOString();
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '12000ms'");
  await client.query("SET LOCAL lock_timeout = '2000ms'");
  console.log('=== P0-C7B / PREFLIGHT INTEGRATO READ ONLY ===');
  const { rows: opportunities } = await client.query(`
    SELECT o.id, o.stato, o.inizio_finestra, o.fine_finestra, o.dati_temporali,
           d.id AS direttrice_id, d.engine_id, d.versione, d.nodi, d.legs, d.stato AS direttrice_stato
    FROM public.pixel_opportunita o
    JOIN public.pixel_direttrici d ON d.id=o.direttrice_id
    WHERE o.id=ANY($1::bigint[]) ORDER BY o.id`, [IDS]);
  check(opportunities.length === 2, 'entrambe le opportunita presenti', `${opportunities.length}/2`);
  for (const o of opportunities) {
    console.log(`\n--- OPPORTUNITA ${o.id} ---`);
    console.log(`direttrice=${o.direttrice_id} engine=${o.engine_id} versione=${o.versione} nodi=${JSON.stringify(o.nodi)}`);
    console.log(`finestra UTC=${iso(o.inizio_finestra)} -> ${iso(o.fine_finestra)}`);
    check(o.stato === 'candidata' && o.direttrice_stato === 'attiva', 'stati PIXEL candidati/attivi');
    check(Array.isArray(o.nodi) && Array.isArray(o.legs) && o.legs.length === o.nodi.length - 1, 'nodi/legs coerenti');
    const seconds = Array.isArray(o.legs) ? o.legs.reduce((n, l) => n + Number(l.seconds || 0), 0) : NaN;
    const metres = Array.isArray(o.legs) ? o.legs.reduce((n, l) => n + Number(l.metres || 0), 0) : NaN;
    check(Number.isFinite(seconds) && seconds > 0 && Number.isFinite(metres) && metres > 0 && o.legs.every(l => typeof l.polyline === 'string' && l.polyline.length > 5), 'geometria stradale utilizzabile', `${metres} m; ${seconds} s`);
    console.log('dati_temporali=', JSON.stringify(o.dati_temporali));
  }
  if (opportunities.length === 2) {
    check(opportunities[0].engine_id === opportunities[1].engine_id, 'stessa direttrice territoriale');
    check(new Date(opportunities[0].fine_finestra) < new Date(opportunities[1].inizio_finestra), 'finestre PIXEL in sequenza');
  }
  const { rows: requests } = await client.query(`
    SELECT o.id AS opportunita_id, r.id, r.stato, r.corsa_id, r.start_datetime,
           r.posti_richiesti, r.prezzo, r.payment_intent_id,
           r.origine_nodo_territoriale_id AS origine_nodo,
           r.destinazione_nodo_territoriale_id AS destinazione_nodo,
           r.start_node_id, r.end_node_id,
           ST_Y(r.origine::geometry) AS lat_origine, ST_X(r.origine::geometry) AS lon_origine,
           ST_Y(r.destinazione::geometry) AS lat_destinazione, ST_X(r.destinazione::geometry) AS lon_destinazione
    FROM public.pixel_opportunita o
    JOIN public.pixel_opportunita_richieste por ON por.opportunita_id=o.id
    JOIN public.richieste_pop_bus r ON r.id=por.richiesta_id
    WHERE o.id=ANY($1::bigint[])
    ORDER BY o.id,r.id`, [IDS]);
  console.log('\n=== RICHIESTE ASSOCIATE ===');
  for (const r of requests) {
    console.log(`op=${r.opportunita_id} req=${r.id} ${r.origine_nodo}->${r.destinazione_nodo} orario=${iso(r.start_datetime)} stato=${r.stato} posti=${r.posti_richiesti} prezzo=${r.prezzo} pagamento=${r.payment_intent_id ?? 'NULL'}`);
  }
  check(requests.some(r => Number(r.opportunita_id) === 115 && Number(r.id) === 196), 'richiesta 196 associata a PIXEL 115');
  check(requests.some(r => Number(r.opportunita_id) === 117 && Number(r.id) === 205), 'richiesta 205 associata a PIXEL 117');
  for (const id of [196, 205]) {
    const r = requests.find(r => Number(r.id) === id);
    if (!r) continue;
    check(Number(r.origine_nodo) === 8 && Number(r.destinazione_nodo) === 5, `richiesta ${id}: mapping territoriale 8->5`);
    check(r.corsa_id == null, `richiesta ${id}: non convertita`);
    const o = opportunities.find(o => Number(o.id) === (id === 196 ? 115 : 117));
    if (o) {
      const deltaStart = Math.round((new Date(r.start_datetime) - new Date(o.inizio_finestra)) / 60000);
      const deltaEnd = Math.round((new Date(r.start_datetime) - new Date(o.fine_finestra)) / 60000);
      console.log(`TEMPO req=${id}: partenza desiderata - finestra PIXEL = ${deltaStart} .. ${deltaEnd} minuti (non equivale al tempo di salita)`);
    }
  }
  const { rows: vehicles } = await client.query(`
    SELECT v.id, v.driver_id, v.posti_totali,
           (SELECT count(*)::int FROM public.disponibilita_veicolo dv WHERE dv.veicolo_id=v.id) AS turni
    FROM public.veicolo v
    WHERE v.posti_totali >= 1
    ORDER BY CASE WHEN EXISTS(SELECT 1 FROM public.disponibilita_veicolo dv WHERE dv.veicolo_id=v.id) THEN 0 ELSE 1 END, v.id
    LIMIT 12`);
  console.log('\n=== VEICOLI CANDIDATI (MAX 12, SOLA LETTURA) ===');
  for (const v of vehicles) console.log(`veicolo=${v.id} titolare=${v.driver_id} capienza=${v.posti_totali} configurazioni_disponibilita=${v.turni}`);
  check(vehicles.some(v => v.turni > 0), 'esiste almeno un veicolo con disponibilita configurata');
  console.log('\n=== VALUTAZIONE ===');
  console.log('Non si assume fattibilita del trasferimento 5->8: serve tratta di riposizionamento con tempi e polilinea validi.');
  console.log('Non si assume compatibilita temporale dalle sole finestre PIXEL: verificare gli orari ai nodi di salita.');
  console.log('Non si assume pagamento autorizzato: i riferimenti NULL richiedono fixture isolata.');
  console.log(`Controlli con ATTENZIONE: ${failures}. Nessuna accettazione invocata.`);
} catch (err) {
  console.error('ERRORE PREFLIGHT:', err.message);
  process.exitCode = 1;
} finally {
  try { await client.query('ROLLBACK'); console.log('ROLLBACK READ ONLY eseguito.'); } catch (e) { console.error('ROLLBACK ERROR:', e.message); process.exitCode = 1; }
  client.release();
  await pool.end();
}
