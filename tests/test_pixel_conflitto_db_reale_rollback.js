// TURENTU — test query reale conflittiVeicolo su una singola transazione PostgreSQL.
// Inserisce una popbus_attivazione temporanea per il veicolo 361 e fa ROLLBACK.
// NON esegue il worker completo, NON emette socket, NON fa COMMIT.
// Usa ESATTAMENTE la SQL di conflittiVeicolo estratta dal worker corrente.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = message => { throw new Error('PIXEL_CONFLITTO_DB: ' + message); };
const root = process.cwd();
const blocked = 361, other = 363;
const start = new Date('2026-11-01T12:00:00.000Z');
const end = new Date('2026-11-01T18:00:00.000Z');
if (process.env.POPBUS_DB_CONFLICT_CONFIRM !== 'CORSE_DB_ROLLBACK')
  fail('Impostare POPBUS_DB_CONFLICT_CONFIRM=CORSE_DB_ROLLBACK');
if (process.env.POPBUS_PIXEL_FIRST === '1') fail('Disabilitare POPBUS_PIXEL_FIRST');
const worker = await readFile(resolve(root, 'services/popbus/v2/worker.js'), 'utf8');
const fn = worker.match(/async function conflittiVeicolo\(client, veicoloId, busyStart, busyEnd\)\s*\{([\s\S]*?)\n\}/);
if (!fn) fail('Funzione conflittiVeicolo non trovata');
const sql = fn[1].match(/client\.query\(`([\s\S]*?)`\s*,\s*\[veicoloId, new Date\(busyStart\), new Date\(busyEnd\)\]\)/);
if (!sql || !sql[1].includes('FROM popbus_attivazioni a') || !sql[1].includes('UNION ALL') || !sql[1].includes('FROM corse c'))
  fail('SQL dei conflitti diversa da quella attesa; test interrotto');
const { pool } = await import(pathToFileURL(resolve(root, 'db/db.js')).href);
const client = await pool.connect();
let began = false;
let inserted = null;
const conflicts = async id => (await client.query(sql[1], [id, start, end])).rows;
try {
  const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
  if (db !== 'corse_db') fail('Database inatteso: ' + db);
  // Un lock di transazione evita sovrapposizioni con il worker, se rispetta lo stesso advisory lock.
  await client.query('BEGIN'); began = true;
  await client.query('SET LOCAL lock_timeout = \'3s\'');
  await client.query('SET LOCAL statement_timeout = \'20s\'');
  await client.query('SELECT pg_advisory_xact_lock(734021,1)');
  const {rows: vehicles} = await client.query('SELECT id,driver_id FROM veicolo WHERE id=ANY($1::int[]) ORDER BY id', [[blocked,other]]);
  if (vehicles.length !== 2 || Number(vehicles[0].driver_id) !== Number(vehicles[1].driver_id))
    fail('I due veicoli non sono disponibili con lo stesso titolare');
  const before361 = await conflicts(blocked);
  const before363 = await conflicts(other);
  if (before361.length || before363.length)
    fail('Intervallo gia occupato nella fixture; nessun inserimento effettuato');
  const {rows: dirs} = await client.query('SELECT id FROM direttrici_virtuali ORDER BY id LIMIT 1');
  if (!dirs.length) fail('Nessuna direttrice di test per soddisfare FK; nessun inserimento effettuato');
  // L'attivazione ha un piano minimo con busyStart/busyEnd; non viene associata a richieste.
  // expires_at nel futuro rispetto alla transazione, per non dipendere dal worker di pulizia.
  const {rows: created} = await client.query(`
    INSERT INTO popbus_attivazioni
      (direttrice_id,veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,expires_at)
    VALUES ($1,$2,$3,'in_attesa_autista',$4,$5,0,0,1,$6::jsonb,NOW()+INTERVAL '10 minutes')
    RETURNING id
  `, [dirs[0].id,blocked,vehicles.find(v=>Number(v.id)===blocked).driver_id,
      start,end,JSON.stringify({busyStart:start.toISOString(),busyEnd:end.toISOString(),test:'PIXEL_CONFLITTO_DB_ROLLBACK'})]);
  inserted = created[0].id;
  const after361 = await conflicts(blocked);
  const after363 = await conflicts(other);
  const found = after361.some(x=>x.origine==='attivazione' && String(x.id)===String(inserted));
  const passed = found && after363.length===0 && after361.length>=1;
  console.log('PIXEL_CONFLITTO_DB_JSON:'+JSON.stringify({db,intervallo:{start:start.toISOString(),end:end.toISOString()},
    veicoli:vehicles,attivazioneTemporaneaId:inserted,prima:{veicolo361:before361.length,veicolo363:before363.length},
    dopo:{veicolo361:after361.length,veicolo363:after363.length},
    queryWorkerOriginale:true,stessaConnessione:true,conflitto361Rilevato:found,altroVeicoloLibero:after363.length===0,passed}));
  if (!passed) fail('La query non ha rispettato gli invarianti');
} finally {
  if (began) {
    try { await client.query('ROLLBACK'); console.log('PIXEL_CONFLITTO_DB_ROLLBACK_OK: ROLLBACK eseguito'); }
    catch(e) { console.error('PIXEL_CONFLITTO_DB_ROLLBACK_ERROR:',e.message); }
  }
  // Verifica su connessione nuova: la riga non deve esistere dopo il rollback.
  client.release();
  if (inserted != null) {
    const verify = await pool.connect();
    try {
      const {rows} = await verify.query('SELECT COUNT(*)::int AS n FROM popbus_attivazioni WHERE id=$1',[inserted]);
      const absent = rows[0].n === 0;
      console.log('PIXEL_CONFLITTO_DB_PERSISTENZA_JSON:'+JSON.stringify({id:inserted,assenteDopoRollback:absent,passed:absent}));
      if (!absent) process.exitCode = 1;
    } finally {verify.release();}
  }
  await pool.end();
}
