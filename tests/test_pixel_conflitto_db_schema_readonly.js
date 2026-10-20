// TURENTU — Diagnostica schema PostgreSQL per fixture conflitto veicolo.
// SOLO LETTURA. Nessun INSERT, UPDATE, DELETE o COMMIT.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const { pool } = await import(pathToFileURL(resolve(root, 'db/db.js')).href);
const client = await pool.connect();
let transaction = false;
try {
  await client.query('BEGIN READ ONLY');
  transaction = true;
  await client.query("SET LOCAL statement_timeout = '15s'");
  const { rows: databases } = await client.query('SELECT current_database() AS db');
  const db = databases[0].db;
  if (db !== 'corse_db') throw new Error(`Database non autorizzato: ${db}`);
  const { rows: counts } = await client.query(`
    SELECT 'direttrici_virtuali' AS tabella, COUNT(*)::int AS righe FROM public.direttrici_virtuali
    UNION ALL SELECT 'popbus_attivazioni', COUNT(*)::int FROM public.popbus_attivazioni
    UNION ALL SELECT 'corse', COUNT(*)::int FROM public.corse
  `);
  const { rows: columns } = await client.query(`
    SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('direttrici_virtuali', 'popbus_attivazioni')
    ORDER BY table_name, ordinal_position
  `);
  const { rows: constraints } = await client.query(`
    SELECT c.conrelid::regclass::text AS tabella, c.conname AS nome,
           c.contype AS tipo, pg_get_constraintdef(c.oid) AS definizione
    FROM pg_constraint c
    WHERE c.conrelid IN ('public.direttrici_virtuali'::regclass,
                         'public.popbus_attivazioni'::regclass)
    ORDER BY tabella, nome
  `);
  const { rows: vehicles } = await client.query(
    'SELECT id, driver_id FROM public.veicolo WHERE id = ANY($1::int[]) ORDER BY id',
    [[361, 363]]
  );
  console.log('PIXEL_SCHEMA_DB_JSON:' + JSON.stringify({ db, counts, vehicles }));
  console.log('PIXEL_SCHEMA_COLUMNS_JSON:' + JSON.stringify(columns));
  console.log('PIXEL_SCHEMA_CONSTRAINTS_JSON:' + JSON.stringify(constraints));
  console.log('PIXEL_SCHEMA_READONLY_OK:' + JSON.stringify({ db, passed: true }));
} catch (error) {
  console.error('PIXEL_SCHEMA_ERROR:', error.stack ?? error.message);
  process.exitCode = 1;
} finally {
  if (transaction) {
    try { await client.query('ROLLBACK'); console.log('PIXEL_SCHEMA_ROLLBACK_OK'); }
    catch (error) { console.error('PIXEL_SCHEMA_ROLLBACK_ERROR:', error.message); process.exitCode = 1; }
  }
  client.release();
  await pool.end();
}
