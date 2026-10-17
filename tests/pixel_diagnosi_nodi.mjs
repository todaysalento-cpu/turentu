// PIXEL — diagnosi sola lettura del catalogo nodi territoriali.
// Copiare in tests/pixel_diagnosi_nodi.mjs
import { pool } from '../db/db.js';

try {
  const client = await pool.connect();
  try {
    const context = await client.query(`SELECT current_database() AS database,
      current_schema() AS schema, current_setting('search_path') AS search_path`);
    console.log('CONNESSIONE:', context.rows[0]);

    const tables = await client.query(`SELECT n.nspname AS schema, c.relname AS tabella,
      c.oid::regclass::text AS riferimento
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'nodi_territoriali' AND c.relkind IN ('r','p','v','m')
      ORDER BY n.nspname`);
    console.table(tables.rows);

    const meta = await client.query('SELECT * FROM nodi_territoriali LIMIT 0');
    console.log('COLONNE RISOLTE:', meta.fields.map(f => f.name));

    const data = await client.query('SELECT * FROM nodi_territoriali WHERE id = ANY($1::int[])', [[6,5,7]]);
    console.log('RIGHE TROVATE:', data.rowCount);
    for (const row of data.rows) console.log('NODO:', JSON.stringify(row));
  } finally {
    client.release();
  }
} catch (e) {
  console.error('DIAGNOSI FALLITA:', e.stack ?? e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
