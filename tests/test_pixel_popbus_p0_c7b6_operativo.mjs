// TURENTU P0-C7B.6 — preflight operativo, SOLA LETTURA
// Non sostituisce verificaTurnoVeicolo() né la valutazione economica di POPBUS.
// Eseguire: node tests/test_pixel_popbus_p0_c7b6_operativo.mjs
import { pool } from '../db/db.js';

const VEICOLO_ID = 347;
const START = '2026-11-01T13:15:00.000Z';
const END = '2026-11-01T15:13:34.000Z';
const START_MS = Date.parse(START);
const END_MS = Date.parse(END);
const OUTBOUND_METRES = 24459;
const RETURN_TRANSFER_METRES = 24016;
const OUTBOUND_SECONDS = 1714;
const TRANSFER_SECONDS = 1646;
const q = (name) => '"' + name.replaceAll('"', '""') + '"';
const fmt = (v) => v == null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const iso = (v) => v == null ? 'NULL' : new Date(v).toISOString();

let client;
try {
  client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '12000ms'");
  console.log('=== P0-C7B.6 / PREFLIGHT OPERATIVO READ ONLY ===');
  console.log('Ciclo UTC:', START, '->', END);
  console.log('Veicolo candidato:', VEICOLO_ID);
  const meta = await client.query(`
    SELECT table_name,column_name,data_type,udt_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name = ANY($1::text[])
    ORDER BY table_name,ordinal_position`,
    [['veicolo','disponibilita_veicolo','corse','popbus_attivazioni','tariffe','richieste','nodi_territoriali']]);
  const byTable = new Map();
  for (const c of meta.rows) {
    if (!byTable.has(c.table_name)) byTable.set(c.table_name, new Set());
    byTable.get(c.table_name).add(c.column_name);
  }
  const has = (t,c) => byTable.get(t)?.has(c) ?? false;
  const table = (t) => byTable.has(t);
  const pick = (t, candidates) => candidates.find(c => has(t,c));

  if (!table('veicolo') || !has('veicolo','id')) throw new Error('Tabella veicolo/id non individuata');
  const v = await client.query('SELECT * FROM public.veicolo WHERE id=$1',[VEICOLO_ID]);
  if (!v.rows.length) throw new Error('Veicolo 347 assente');
  const vehicle = v.rows[0];
  console.log('\n=== VEICOLO ===');
  for (const k of ['id','driver_id','posti_totali','localita','lat','lon','raggio_km','coord','stato']) if (k in vehicle) console.log(k+'='+fmt(vehicle[k]));

  console.log('\n=== DISPONIBILITA CONFIGURATE ===');
  if (table('disponibilita_veicolo') && has('disponibilita_veicolo','veicolo_id')) {
    const d = await client.query('SELECT * FROM public.disponibilita_veicolo WHERE veicolo_id=$1 ORDER BY id NULLS LAST',[VEICOLO_ID]);
    console.log('Configurazioni:',d.rowCount);
    for (const [i,r] of d.rows.entries()) {
      console.log('Configurazione',i+1);
      for (const [k,val] of Object.entries(r)) console.log('  '+k+'='+fmt(val));
    }
    if (!d.rowCount) console.log('ATTENZIONE: nessuna configurazione per il veicolo');
  } else console.log('ATTENZIONE: schema disponibilita_veicolo non individuato');

  console.log('\n=== CORSE ESISTENTI DEL VEICOLO ===');
  if (table('corse') && has('corse','veicolo_id')) {
    const begin = pick('corse',['start_datetime','partenza','data_partenza']);
    const finish = pick('corse',['arrivo_datetime','end_datetime','arrivo','data_arrivo']);
    if (begin && finish) {
      const cols = ['id','stato',begin,finish].filter(c=>has('corse',c));
      const sql = `SELECT ${[...new Set(cols)].map(q).join(',')} FROM public.corse WHERE veicolo_id=$1 AND ${q(begin)} < $3::timestamptz AND ${q(finish)} > $2::timestamptz ORDER BY ${q(begin)} LIMIT 30`;
      const c = await client.query(sql,[VEICOLO_ID,START,END]);
      console.log('Corse sovrapposte all intervallo missioni (senza filtro stato):',c.rowCount);
      for(const r of c.rows) console.log(JSON.stringify(r));
    } else console.log('ATTENZIONE: colonne inizio/fine corse non riconosciute');
  } else console.log('ATTENZIONE: tabella corse non individuata');

  console.log('\n=== ATTIVAZIONI ESISTENTI DEL VEICOLO ===');
  if (table('popbus_attivazioni') && has('popbus_attivazioni','veicolo_id')) {
    const begin = pick('popbus_attivazioni',['partenza','start_datetime']);
    const finish = pick('popbus_attivazioni',['arrivo','arrivo_datetime']);
    if (begin && finish) {
      const cols=['id','stato','corsa_id',begin,finish].filter(c=>has('popbus_attivazioni',c));
      const a=await client.query(`SELECT ${[...new Set(cols)].map(q).join(',')} FROM public.popbus_attivazioni WHERE veicolo_id=$1 AND ${q(begin)} < $3::timestamptz AND ${q(finish)} > $2::timestamptz ORDER BY ${q(begin)} LIMIT 30`,[VEICOLO_ID,START,END]);
      console.log('Attivazioni sovrapposte (senza filtro stato):',a.rowCount);
      for(const r of a.rows) console.log(JSON.stringify(r));
    } else console.log('ATTENZIONE: colonne temporali attivazioni non riconosciute');
  } else console.log('ATTENZIONE: tabella attivazioni non individuata');

  console.log('\n=== TARIFFE DEL VEICOLO / TITOLARE ===');
  if (table('tariffe')) {
    const tcols=byTable.get('tariffe');
    const key=pick('tariffe',['veicolo_id','driver_id','autista_id']);
    if (key) {
      const owner=key==='veicolo_id'?VEICOLO_ID:vehicle.driver_id;
      const t=await client.query(`SELECT * FROM public.tariffe WHERE ${q(key)}=$1 LIMIT 20`,[owner]);
      console.log('Righe tariffarie:',t.rowCount);
      for(const r of t.rows) console.log(JSON.stringify(r));
    } else console.log('Schema tariffe:',[...tcols].join(', '),'(nessuna chiave nota per filtro sicuro)');
  } else console.log('Tabella tariffe non trovata');

  console.log('\n=== ECONOMIA: DATI CERTI DEL CICLO ===');
  const loaded = OUTBOUND_METRES * 2;
  const movement = loaded + RETURN_TRANSFER_METRES;
  console.log('km con passeggeri:',(loaded/1000).toFixed(3));
  console.log('km riposizionamento:',(RETURN_TRANSFER_METRES/1000).toFixed(3));
  console.log('km totali senza avvicinamento e rientro:',(movement/1000).toFixed(3));
  console.log('secondi movimento:',OUTBOUND_SECONDS*2+TRANSFER_SECONDS);
  console.log('secondi ciclo inclusa sosta:',(END_MS-START_MS)/1000);
  console.log('sosta intermedia secondi:',(END_MS-START_MS)-(OUTBOUND_SECONDS*2+TRANSFER_SECONDS));
  console.log('Ricavi richieste 196+205, se confermati a EUR 7 ciascuna: EUR 14 (non ricavo certificato)');
  console.log('ATTENZIONE: costi, soglia di attivazione, avvicinamento e rientro NON calcolati.');
  console.log('ATTENZIONE: configurazioni e assenza di conflitti visibili NON sostituiscono verificaTurnoVeicolo().');
  console.log('ESITO: diagnostica eseguita, NON equivale ad accettazione.');
} catch (e) {
  console.error('FAIL P0-C7B.6:',e.stack || e.message);
  process.exitCode=1;
} finally {
  if (client) {
    try { await client.query('ROLLBACK'); console.log('ROLLBACK READ ONLY eseguito.'); } catch(e) { console.error('ROLLBACK ERROR:',e.message); }
    client.release();
  }
  await pool.end();
}
