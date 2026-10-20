// TURENTU — registro A/R: integrazione PostgreSQL reale, SOLO LETTURA.
// Collocare in tests/ e rinominare .mjs.txt -> .mjs.
// Richiede tests/pixel-ar-registry.js.txt e db/db.js del progetto.
// Nessuna INSERT/UPDATE/DELETE, nessuna modifica ai sorgenti.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
if (process.env.POPBUS_PIXEL_FIRST === '1') throw new Error('POPBUS_PIXEL_FIRST deve essere disabilitato');
if (process.env.POPBUS_AR_DB_CONFIRM !== 'CORSE_DB_READONLY')
  throw new Error('Conferma richiesta: set POPBUS_AR_DB_CONFIRM=CORSE_DB_READONLY');

const moduleText = await readFile(resolve(root, 'tests/pixel-ar-registry.js.txt'), 'utf8');
// Import da data URL: il sorgente .txt non viene rinominato né scritto su disco.
const registry = await import('data:text/javascript;base64,' + Buffer.from(moduleText).toString('base64'));
const { pool } = await import(pathToFileURL(resolve(root, 'db/db.js')).href);
let client;
let inTransaction = false;
let checks = 0;
const pass = (label) => { checks++; console.log('PASS ' + label); };
try {
  client = await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  inTransaction = true;
  const settings = (await client.query(`SELECT current_database() AS db,
    current_setting('transaction_read_only') AS read_only,
    current_setting('transaction_isolation') AS isolation`)).rows[0];
  assert.equal(settings.db, 'corse_db', 'Database diverso da corse_db');
  pass('database corse_db verificato');
  assert.equal(settings.read_only, 'on');
  assert.equal(settings.isolation, 'repeatable read');
  pass('snapshot REPEATABLE READ READ ONLY');

  const rows = (await client.query(`SELECT id, ar_group_id, ar_tratta, ar_vincolata, stato, corsa_id
    FROM public.richieste_pop_bus ORDER BY id`)).rows;
  const ids = rows.map(r => Number(r.id));
  assert.equal(new Set(ids).size, ids.length);
  pass('richieste reali lette senza duplicati');

  // La funzione legge lo stesso snapshot, tramite lo STESSO client PostgreSQL.
  const out = await registry.leggiRegistroAr({ client, richiestaIds: ids });
  assert.deepEqual(out.richiesteCandidateIds, [...ids].sort((a,b)=>a-b));
  pass('registro Node legge tutte le richieste dello snapshot');

  const ordinary = rows.filter(r => r.ar_vincolata === false);
  const linked = rows.filter(r => r.ar_vincolata === true);
  assert.ok(ordinary.every(r => r.ar_group_id === null && r.ar_tratta === null));
  assert.ok(ordinary.every(r => !out.esclusiIds.includes(Number(r.id))));
  pass('ordinarie preservate e metadati coerenti');

  const candidateRows = rows.filter(r => r.ar_vincolata === true);
  const covered = new Set(out.arPairs.flatMap(p => [p.andata, p.ritorno]));
  assert.ok(out.arPairs.every(p => p.andata !== p.ritorno));
  assert.ok(out.arPairs.every(p => candidateRows.some(r => Number(r.id) === p.andata && r.ar_tratta === 'andata')));
  assert.ok(out.arPairs.every(p => candidateRows.some(r => Number(r.id) === p.ritorno && r.ar_tratta === 'ritorno')));
  assert.ok([...covered].every(id => !out.esclusiIds.includes(id)));
  pass('coppie prodotte coerenti con le tratte reali');

  // Il registro non deve trattare richieste A/R escluse come ordinarie.
  const expectedExcluded = new Set(out.esclusiIds);
  const mockCandidates = rows.map(r => ({ richieste: [[Number(r.id)]], margine_ciclo_con_attesa_euro: 1 }));
  const filtered = registry.filtraCandidateAr(mockCandidates, out);
  assert.deepEqual(filtered.map(c => c.richieste[0][0]).sort((a,b)=>a-b),
    ids.filter(id => !expectedExcluded.has(id)).sort((a,b)=>a-b));
  pass('filtro preserva ordinarie ed esclude soltanto ID non verificabili');

  const summary = {
    passed: true, checksPassed: checks, db: settings.db, isolation: settings.isolation,
    richiesteTotali: rows.length, ordinarie: ordinary.length, arVincolate: linked.length,
    coppieCompleteNelBatch: out.arPairs.length, richiesteArEscluse: out.esclusiIds.length,
    gruppiIncompleti: out.gruppiIncompleti.length, gruppiIncoerenti: out.gruppiIncoerenti.length,
    dbWrites: 0, workerModified: false,
    scope: 'lettura reale del registro; con 0 A/R non certifica coppie reali, ottimizzazione o commit'
  };
  console.log('PIXEL_AR_REGISTRY_POSTGRES_READONLY_JSON:' + JSON.stringify(summary));
} finally {
  if (client) {
    try { if (inTransaction) await client.query('ROLLBACK'); }
    finally { client.release(); }
  }
  await pool.end();
}
