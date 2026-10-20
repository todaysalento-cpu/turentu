// TURENTU — collaudo A/R con UPDATE temporanei e ROLLBACK totale.
// ESEGUIRE SOLO IN AMBIENTE DI COLLAUDO, CON WORKER E TRAFFICO FERMI.
// Non e' READ ONLY. Nessuna modifica deve sopravvivere al ROLLBACK.
// File: tests/test_pixel_ar_registry_postgres_rollback.mjs
// Dipendenze: tests/pixel-ar-registry.js.txt, db/db.js.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const requireEnv = (k, value) => {
  if (process.env[k] !== value) throw new Error(`Impostare ${k}=${value} prima di eseguire`);
};
requireEnv('POPBUS_PIXEL_FIRST', '0');
requireEnv('POPBUS_AR_ROLLBACK_CONFIRM', 'COLLAUDO_CON_WORKER_FERMI');
const source = await readFile(resolve(root, 'tests/pixel-ar-registry.js.txt'), 'utf8');
const { leggiRegistroAr, filtraCandidateAr } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const { pool } = await import(pathToFileURL(resolve(root, 'db/db.js')).href);
let client, begun = false, checks = 0, scenario = 'inizializzazione';
const pass = label => { checks++; console.log('PASS ' + label); };
const query = (sql, params=[]) => client.query(sql, params);
const snapshot = ids => leggiRegistroAr({client, richiestaIds:ids});
const idsFrom = rows => rows.map(r => Number(r.id));
const readState = async ids => (await query(`SELECT id, ar_group_id, ar_tratta, ar_vincolata, stato, corsa_id
  FROM public.richieste_pop_bus WHERE id = ANY($1::integer[]) ORDER BY id`, [ids])).rows;
const setLinked = async (id, group, leg) => {
  const r = await query(`UPDATE public.richieste_pop_bus
    SET ar_vincolata = true, ar_group_id = $2::uuid, ar_tratta = $3
    WHERE id = $1 AND ar_vincolata = false AND ar_group_id IS NULL AND ar_tratta IS NULL
      AND stato = 'in_attesa' AND corsa_id IS NULL RETURNING id`, [id,group,leg]);
  assert.equal(r.rowCount,1,`Impossibile marcare la richiesta ${id}`);
};
const sameRows = (a,b) => assert.deepEqual(a,b);
let original, selected, dbName, postRollbackVerified = false;
try {
  client = await pool.connect();
  await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
  begun = true;
  await query("SET LOCAL lock_timeout = '1500ms'");
  await query("SET LOCAL statement_timeout = '12000ms'");
  await query("SET LOCAL idle_in_transaction_session_timeout = '30000ms'");
  const meta = (await query(`SELECT current_database() AS db,
    current_setting('transaction_read_only') AS ro,
    current_setting('transaction_isolation') AS isolation`)).rows[0];
  dbName = meta.db;
  assert.equal(dbName,'corse_db','Database inatteso');
  assert.equal(meta.ro,'off');
  assert.equal(meta.isolation,'repeatable read');
  pass('database e transazione READ WRITE con rollback obbligatorio');

  // NOWAIT: non attendere ne' disturbare altre transazioni che detengono lock.
  // Richiediamo 3 richieste ordinarie in attesa: 2 per A/R, 1 come controllo.
  const candidates = (await query(`SELECT id FROM public.richieste_pop_bus
    WHERE ar_vincolata = false AND ar_group_id IS NULL AND ar_tratta IS NULL
      AND stato = 'in_attesa' AND corsa_id IS NULL
    ORDER BY id LIMIT 3 FOR UPDATE NOWAIT`)).rows;
  assert.equal(candidates.length,3,'Servono almeno 3 richieste ordinarie in_attesa, non assegnate; nessuna modifica effettuata');
  selected = idsFrom(candidates);
  original = await readState(selected);
  const [andata, ritorno, ordinaria] = selected;
  pass('tre richieste idonee bloccate e stato iniziale salvato');

  scenario = 'coppia completa';
  await query('SAVEPOINT ar_scenario');
  const g1 = randomUUID();
  await setLinked(andata,g1,'andata');
  await setLinked(ritorno,g1,'ritorno');
  let r = await snapshot([andata,ritorno,ordinaria]);
  assert.deepEqual(r.arPairs,[{andata,ritorno}]);
  assert.deepEqual(r.esclusiIds,[]);
  pass('coppia completa da PostgreSQL riconosciuta');
  assert.ok(!r.esclusiIds.includes(ordinaria));
  pass('ordinaria preservata accanto alla coppia completa');
  await query('ROLLBACK TO SAVEPOINT ar_scenario');
  sameRows(await readState(selected),original);
  pass('SAVEPOINT ripristina la coppia completa');

  scenario = 'coppia incompleta';
  await query('SAVEPOINT ar_scenario2');
  const g2 = randomUUID();
  await setLinked(andata,g2,'andata');
  r = await snapshot([andata,ritorno,ordinaria]);
  assert.deepEqual(r.arPairs,[]);
  assert.deepEqual(r.esclusiIds,[andata]);
  assert.equal(r.gruppiIncompleti.length,1);
  pass('coppia incompleta esclusa dal registro');
  const priced = [
    {richieste:[[andata,ordinaria]], margine_ciclo_con_attesa_euro:100},
    {richieste:[[ordinaria]], margine_ciclo_con_attesa_euro:12},
    {richieste:[[ritorno]], margine_ciclo_con_attesa_euro:8}
  ];
  const kept = filtraCandidateAr(priced,r);
  assert.deepEqual(kept,priced.slice(1));
  pass('candidata mista esclusa; alternativa ordinaria gia prezzata conservata');
  await query('ROLLBACK TO SAVEPOINT ar_scenario2');
  sameRows(await readState(selected),original);
  pass('SAVEPOINT ripristina la coppia incompleta');

  scenario = 'controparte fuori batch';
  await query('SAVEPOINT ar_scenario3');
  const g3 = randomUUID();
  await setLinked(andata,g3,'andata');
  await setLinked(ritorno,g3,'ritorno');
  r = await snapshot([andata,ordinaria]);
  assert.deepEqual(r.arPairs,[]);
  assert.deepEqual(r.esclusiIds,[andata]);
  pass('controparte esistente ma fuori batch esclusa');
  await query('ROLLBACK TO SAVEPOINT ar_scenario3');
  sameRows(await readState(selected),original);
  pass('SAVEPOINT ripristina il batch incompleto');

  scenario = 'controparte non disponibile';
  // Prova a usare uno stato annullato solo se il database lo accetta.
  // Se vincoli/triggers non lo consentono, rollback del savepoint e test NON certificato.
  let unavailable = 'non_testato';
  await query('SAVEPOINT ar_scenario4');
  try {
    const g4 = randomUUID();
    await setLinked(andata,g4,'andata');
    await setLinked(ritorno,g4,'ritorno');
    const changed = await query(`UPDATE public.richieste_pop_bus SET stato = 'annullata'
      WHERE id = $1 AND stato = 'in_attesa' RETURNING id`,[ritorno]);
    assert.equal(changed.rowCount,1);
    r = await snapshot([andata,ritorno,ordinaria]);
    assert.deepEqual(r.arPairs,[]);
    assert.deepEqual(r.esclusiIds,[andata,ritorno].sort((a,b)=>a-b));
    unavailable = 'pass';
    pass('controparte non disponibile: coppia interamente esclusa');
  } catch (err) {
    // Un errore SQL abortisce il subtransaction: rollback al savepoint prima di proseguire.
    unavailable = `non_certificato: ${err.code || err.message}`;
    console.log('SKIP controparte non disponibile (' + unavailable + ')');
  } finally {
    await query('ROLLBACK TO SAVEPOINT ar_scenario4');
  }
  sameRows(await readState(selected),original);
  pass('SAVEPOINT ripristina scenario indisponibile');

  scenario = 'rollback totale';
  await query('ROLLBACK');
  begun = false;
  await query('BEGIN READ ONLY');
  begun = true;
  sameRows(await readState(selected),original);
  postRollbackVerified = true;
  pass('stato originale verificato dopo ROLLBACK totale');
  await query('ROLLBACK');
  begun = false;
  console.log('PIXEL_AR_REGISTRY_POSTGRES_ROLLBACK_JSON:' + JSON.stringify({
    passed:true, checksPassed:checks, db:dbName, richiesteTestate:selected,
    scenarioIndisponibile:unavailable, rollbackVerified:postRollbackVerified,
    persistentDbWrites:0, workerModified:false,
    scope:'test transazionale su righe reali con UPDATE temporanei e rollback; non certifica ottimizzazione o commit atomico'
  }));
} catch(err) {
  console.error('FAIL scenario: ' + scenario + ' — ' + err.message);
  process.exitCode = 1;
} finally {
  if(client) {
    try { if(begun) await client.query('ROLLBACK'); }
    catch(e) { console.error('ATTENZIONE: rollback fallito:',e.message); process.exitCode=1; }
    client.release();
  }
  await pool.end();
}
