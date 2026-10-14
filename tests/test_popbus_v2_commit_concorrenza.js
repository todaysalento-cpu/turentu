/**
 * TURENTU POPBUS V2 — TEST 6
 * COMMIT reale e rivalidazione concorrente su schema isolato.
 *
 * NON esegue il worker reale; NON modifica tabelle applicative;
 * NON genera offerte/socket/pagamenti.
 *
 * Esecuzione: node --env-file=.env tests/test_popbus_v2_commit_concorrenza.js
 */
import { randomBytes } from 'node:crypto';
import { pool } from '../db/db.js';

const schema = `test_popbus_conc_${randomBytes(6).toString('hex')}`;
const ident = `"${schema}"`;
const LOCK_1 = 734022; // Namespace DIVERSO dal worker reale (734021,1)
const LOCK_2 = 6;
const REQUEST_ID = 900000001;
const VEHICLE_ID = 353;
const assert = (condition, msg) => { if (!condition) throw new Error(msg); };
const log = (message) => console.log(message);
let admin, a, b;
let aTx = false, bTx = false, schemaCreated = false;

async function rollback(c, name) {
  if (!c) return;
  try { await c.query('ROLLBACK'); } catch (e) {
    console.error(`AVVISO: rollback ${name} fallito:`, e.message);
  }
}
async function takeLock(c) {
  await c.query('SELECT pg_advisory_xact_lock($1::int,$2::int)', [LOCK_1, LOCK_2]);
}
async function rivalida(c, snapshot) {
  const { rows } = await c.query(
    `SELECT id, stato, corsa_id, posti
       FROM ${ident}.richieste
      WHERE id=$1 FOR UPDATE`, [REQUEST_ID]);
  if (rows.length !== 1) return { ok:false, reason:'richiesta assente' };
  const r = rows[0];
  if (r.stato !== 'in_attesa' || r.corsa_id !== null ||
      r.posti !== snapshot.posti) {
    return { ok:false, reason:'snapshot modificato' };
  }
  const existing = await c.query(
    `SELECT 1 FROM ${ident}.prenotazioni
      WHERE richiesta_id=$1 AND attiva LIMIT 1`, [REQUEST_ID]);
  if (existing.rowCount) return { ok:false, reason:'richiesta già riservata' };
  return { ok:true };
}
async function main() {
  log('=== POPBUS V2 | COMMIT CONCORRENZA | SCHEMA ISOLATO ===');
  log('Non esegue il worker; nessuna modifica alle tabelle operative.');
  admin = await pool.connect();
  a = await pool.connect();
  b = await pool.connect();
  const pids = await Promise.all([a,b].map(c=>c.query('SELECT pg_backend_pid() AS pid')));
  assert(pids[0].rows[0].pid !== pids[1].rows[0].pid, 'Connessioni non indipendenti');
  log(`DB | connessioni A=${pids[0].rows[0].pid} B=${pids[1].rows[0].pid}`);

  await admin.query(`CREATE SCHEMA ${ident}`);
  schemaCreated = true;
  await admin.query(`CREATE TABLE ${ident}.richieste (
    id integer PRIMARY KEY, stato text NOT NULL,
    corsa_id integer, posti integer NOT NULL
  )`);
  await admin.query(`CREATE TABLE ${ident}.attivazioni (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    veicolo_id integer NOT NULL, richiesta_id integer NOT NULL
  )`);
  await admin.query(`CREATE TABLE ${ident}.prenotazioni (
    attivazione_id integer NOT NULL REFERENCES ${ident}.attivazioni(id),
    richiesta_id integer NOT NULL REFERENCES ${ident}.richieste(id),
    attiva boolean NOT NULL DEFAULT true
  )`);
  await admin.query(`CREATE UNIQUE INDEX test_unica_richiesta_attiva
    ON ${ident}.prenotazioni(richiesta_id) WHERE attiva`);
  await admin.query(`CREATE TABLE ${ident}.offerte (
    attivazione_id integer NOT NULL REFERENCES ${ident}.attivazioni(id),
    veicolo_id integer NOT NULL,
    UNIQUE(attivazione_id, veicolo_id)
  )`);
  await admin.query(`INSERT INTO ${ident}.richieste
    (id, stato, corsa_id, posti) VALUES ($1,'in_attesa',NULL,4)`, [REQUEST_ID]);
  log(`ISOLAMENTO | schema ${schema} creato: PASS`);

  // Routing già completato da A e B: entrambi conservano lo stesso snapshot.
  const snapshot = { id: REQUEST_ID, stato:'in_attesa', corsa_id:null, posti:4 };
  log('SNAPSHOT | A e B selezionano la stessa richiesta e il veicolo 353');

  await a.query('BEGIN'); aTx=true;
  await takeLock(a);
  log('A | advisory lock acquisito');

  await b.query('BEGIN'); bTx=true;
  const denied = await b.query(
    'SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS acquired',
    [LOCK_1, LOCK_2]);
  assert(denied.rows[0].acquired === false, 'B ha acquisito il lock detenuto da A');
  log('B | lock negato mentre A opera: PASS');

  const first = await rivalida(a, snapshot);
  assert(first.ok, `A rivalidazione fallita: ${first.reason}`);
  const act = await a.query(
    `INSERT INTO ${ident}.attivazioni(veicolo_id,richiesta_id)
     VALUES($1,$2) RETURNING id`, [VEHICLE_ID,REQUEST_ID]);
  const actId = act.rows[0].id;
  await a.query(`INSERT INTO ${ident}.prenotazioni
    (attivazione_id,richiesta_id,attiva) VALUES($1,$2,true)`,
    [actId, REQUEST_ID]);
  await a.query(`INSERT INTO ${ident}.offerte
    (attivazione_id,veicolo_id) VALUES($1,$2)`, [actId,VEHICLE_ID]);
  await a.query(`UPDATE ${ident}.richieste SET stato='in_lavorazione'
    WHERE id=$1`, [REQUEST_ID]);
  await a.query('COMMIT'); aTx=false;
  log('A | rivalidazione, attivazione, prenotazione, offerta, COMMIT: PASS');

  const acquired = await b.query(
    'SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS acquired',
    [LOCK_1, LOCK_2]);
  assert(acquired.rows[0].acquired === true, 'B non ha acquisito il lock dopo COMMIT A');
  const second = await rivalida(b, snapshot);
  assert(second.ok === false, 'CRITICO: B ha accettato una richiesta già impegnata');
  log(`B | rivalidazione rifiutata (${second.reason}): PASS`);
  await b.query('COMMIT'); bTx=false;

  const [counts, state] = await Promise.all([
    admin.query(`SELECT
      (SELECT count(*)::int FROM ${ident}.attivazioni) AS attivazioni,
      (SELECT count(*)::int FROM ${ident}.prenotazioni WHERE attiva) AS prenotazioni,
      (SELECT count(*)::int FROM ${ident}.offerte) AS offerte`),
    admin.query(`SELECT stato FROM ${ident}.richieste WHERE id=$1`,[REQUEST_ID])
  ]);
  const c=counts.rows[0];
  assert(c.attivazioni===1 && c.prenotazioni===1 && c.offerte===1,
    `Duplicati: ${JSON.stringify(c)}`);
  assert(state.rows[0].stato==='in_lavorazione', 'Stato richiesta inatteso');
  log(`VERIFICA | attivazioni=${c.attivazioni} prenotazioni=${c.prenotazioni} offerte=${c.offerte}: PASS`);

  // Controllo aggiuntivo: vincolo DB impedisce la doppia prenotazione attiva.
  await b.query('BEGIN'); bTx=true;
  let uniqueViolation=false;
  try {
    await b.query(`INSERT INTO ${ident}.prenotazioni
      (attivazione_id,richiesta_id,attiva) VALUES($1,$2,true)`,
      [actId,REQUEST_ID]);
  } catch(e) {
    if(e.code==='23505') uniqueViolation=true;
    else throw e;
  }
  await b.query('ROLLBACK'); bTx=false;
  assert(uniqueViolation, 'Vincolo unicità non ha bloccato duplicazione');
  log('VINCOLO DB | seconda prenotazione attiva respinta (23505): PASS');
  log('ESITO FINALE: PASS — COMMIT reale nello schema isolato');
  log('NON VERIFICATO: codice reale del worker, vincoli tabelle operative, socket, cron, pagamenti.');
}
main().catch(e=>{
  console.error('ESITO FINALE: FAIL', e.code || '', e.message);
  process.exitCode=1;
}).finally(async()=>{
  if(aTx) await rollback(a,'A');
  if(bTx) await rollback(b,'B');
  // Attenzione: elimina soltanto lo schema casuale creato da questo test.
  if(admin && schemaCreated) {
    try {
      await admin.query(`DROP SCHEMA ${ident} CASCADE`);
      log('PULIZIA | schema sintetico eliminato: PASS');
    } catch(e) {
      console.error(`PULIZIA FALLITA | schema ${schema}:`,e.message);
      process.exitCode=1;
    }
  }
  a?.release(); b?.release(); admin?.release();
  await pool.end();
});
