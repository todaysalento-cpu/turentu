// TURENTU — test di isolamento concorrente PostgreSQL, SOLO corse_db.
// Due connessioni reali. Nessuna INSERT/UPDATE/DELETE, nessun COMMIT.
// Verifica il protocollo di lock PROPOSTO; NON certifica che il worker lo usi.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const assert = (v, m) => { if (!v) throw new Error('PIXEL_CONCORRENZA: ' + m); };
assert(process.env.POPBUS_PIXEL_CONCURRENCY_CONFIRM === 'CORSE_DB_READONLY', 'Conferma richiesta: POPBUS_PIXEL_CONCURRENCY_CONFIRM=CORSE_DB_READONLY');
assert(process.env.POPBUS_PIXEL_FIRST !== '1', 'POPBUS_PIXEL_FIRST deve restare disabilitato');
const { pool } = await import(pathToFileURL(resolve(ROOT, 'db/db.js')).href);
let a, b, startedA = false, startedB = false;
const checks = {};
const tryLock = async (client, domain, id) => {
  const { rows } = await client.query('SELECT pg_try_advisory_xact_lock($1::integer,$2::integer) AS acquired', [domain, id]);
  return rows[0].acquired;
};
try {
  a = await pool.connect();
  b = await pool.connect();
  const { rows: info } = await a.query('SELECT current_database() AS db, pg_backend_pid() AS pid');
  const { rows: infoB } = await b.query('SELECT current_database() AS db, pg_backend_pid() AS pid');
  assert(info[0].db === 'corse_db' && infoB[0].db === 'corse_db', 'Database diverso da corse_db');
  assert(info[0].pid !== infoB[0].pid, 'Le connessioni non sono distinte');
  const { rows: opportunities } = await a.query('SELECT id FROM pixel_opportunita ORDER BY id LIMIT 2');
  const { rows: requests } = await a.query('SELECT richiesta_id FROM pixel_opportunita_richieste ORDER BY richiesta_id LIMIT 2');
  const { rows: vehicles } = await a.query('SELECT id FROM veicolo WHERE id IN (361,363) ORDER BY id');
  assert(opportunities.length >= 2 && requests.length >= 2 && vehicles.length === 2, 'Fixture insufficiente: servono 2 opportunita, 2 richieste, veicoli 361 e 363');
  const opp1 = Number(opportunities[0].id), opp2 = Number(opportunities[1].id);
  const req1 = Number(requests[0].richiesta_id);
  const vehicle1 = Number(vehicles[0].id), vehicle2 = Number(vehicles[1].id);
  assert([opp1,opp2,req1,vehicle1,vehicle2].every(Number.isSafeInteger), 'Identificativi non validi');
  // Namespace distinti: opportunita=734101, richiesta=734102, veicolo=734103.
  // Questi lock sono COOPERATIVI: il percorso operativo dovra acquisirli sempre,
  // in ordine deterministico, prima di leggere e scrivere le assegnazioni.
  await a.query('BEGIN READ ONLY'); startedA = true;
  await b.query('BEGIN READ ONLY'); startedB = true;
  for (const c of [a,b]) {
    await c.query("SET LOCAL lock_timeout = '2s'");
    await c.query("SET LOCAL statement_timeout = '8s'");
  }
  checks.opportunitaPrimaAcquisita = await tryLock(a,734101,opp1);
  checks.stessaOpportunitaBloccata = !(await tryLock(b,734101,opp1));
  checks.altraOpportunitaIndipendente = await tryLock(b,734101,opp2);
  checks.richiestaPrimaAcquisita = await tryLock(a,734102,req1);
  checks.stessaRichiestaBloccata = !(await tryLock(b,734102,req1));
  checks.veicoloPrimaAcquisito = await tryLock(a,734103,vehicle1);
  checks.stessoVeicoloBloccato = !(await tryLock(b,734103,vehicle1));
  checks.altroVeicoloIndipendente = await tryLock(b,734103,vehicle2);
  await a.query('ROLLBACK'); startedA = false;
  checks.lockRilasciatoDopoRollback = await tryLock(b,734101,opp1);
  checks.richiestaRilasciataDopoRollback = await tryLock(b,734102,req1);
  checks.veicoloRilasciatoDopoRollback = await tryLock(b,734103,vehicle1);
  const passed = Object.values(checks).every(Boolean);
  console.log('PIXEL_CONCORRENZA_JSON:' + JSON.stringify({db:info[0].db,passed,connessioniDistinte:true,
    opportunita:[opp1,opp2],richiesta:req1,veicoli:[vehicle1,vehicle2],checks,
    limiti:['Verifica advisory lock PostgreSQL, non il percorso di attivazione del worker',
      'Non prova idempotenza o unicita garantita da indici/vincoli SQL',
      'Non esegue INSERT o COMMIT: nessuna attivazione creata',
      'I lock sono cooperativi: servono acquisizione nel codice operativo e vincoli persistenti'] }));
  assert(passed, 'Una o piu asserzioni fallite');
} catch (e) {
  console.error('PIXEL_CONCORRENZA_ERROR:',e.stack || e.message);
  process.exitCode = 1;
} finally {
  for (const [client,started,label] of [[a,startedA,'A'],[b,startedB,'B']]) {
    if (!client) continue;
    if (started) {
      try { await client.query('ROLLBACK'); console.log('PIXEL_CONCORRENZA_ROLLBACK_'+label+'_OK'); }
      catch(e) { console.error('PIXEL_CONCORRENZA_ROLLBACK_'+label+'_ERROR:',e.message);process.exitCode=1; }
    }
    client.release();
  }
  await pool.end();
}
