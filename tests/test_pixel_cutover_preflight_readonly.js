// TURENTU — audit PRE-CUTOVER PIXEL/POPBUS, SOLO LETTURA.
// Eseguire dalla root: node --env-file=.env tests/test_pixel_cutover_preflight_readonly.js
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const ROOT = process.cwd();
const path = p => resolve(ROOT, p);
const { pool } = await import(pathToFileURL(path('db/db.js')).href);
const paths = {
  worker: 'services/popbus/v2/worker.js',
  persistence: 'services/popbus/v2/popbus-cycle-persistence.js'
};
let client;
try {
  client = await pool.connect();
  const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
  if (db !== 'corse_db') throw new Error('Database non consentito: ' + db);
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '15000ms'");
  const schema = (await client.query(`
    SELECT c.relname AS tabella, con.conname AS vincolo,
           pg_get_constraintdef(con.oid) AS definizione
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
    WHERE c.relnamespace='public'::regnamespace
      AND c.relname IN ('popbus_attivazioni','popbus_attivazione_richieste',
                        'popbus_attivazione_missioni','popbus_missione_richieste')
    ORDER BY c.relname,con.conname
  `)).rows;
  const indexes = (await client.query(`
    SELECT tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename IN
      ('popbus_attivazioni','popbus_attivazione_richieste',
       'popbus_attivazione_missioni','popbus_missione_richieste')
    ORDER BY tablename,indexname
  `)).rows;
  const files = {};
  for (const [name, rel] of Object.entries(paths)) {
    const src = await readFile(path(rel),'utf8');
    files[name] = {
      percorso: rel,
      pixelOpportunitaId: src.includes('pixelOpportunitaId'),
      pixelOpportunitaSQL: src.includes('pixel_opportunita_id'),
      advisoryLock: /pg_(try_)?advisory_xact_lock/i.test(src),
      verificaConflitti: /conflittiVeicolo/.test(src),
      legacyDirettrici: /INSERT\s+INTO\s+direttrici_virtuali/i.test(src),
      registraMissioni: /registraMissioniAttivazione/.test(src)
    };
  }
  console.log('PIXEL_CUTOVER_PREFLIGHT_JSON:'+JSON.stringify({db,files,vincoli:schema,indici:indexes,
    nota:'Audit strutturale: la presenza di una stringa non prova che il ramo operativo usi i lock.'}));
} catch (e) {
  console.error('PIXEL_CUTOVER_PREFLIGHT_ERROR:',e.stack||e.message);
  process.exitCode=1;
} finally {
  if(client) {
    try { await client.query('ROLLBACK'); console.log('PIXEL_CUTOVER_PREFLIGHT_ROLLBACK_OK'); }
    catch(e){console.error('ROLLBACK_ERROR:',e.message);process.exitCode=1;}
    client.release();
  }
  await pool.end();
}
