// TURENTU P0-C7B.3 — Individuazione coordinate nodi 5 e 8 (READ ONLY)
// Salvare in tests/test_pixel_popbus_p0_c7b_nodi_routing.mjs
// Non chiama Google Maps; non modifica dati.
import { pool } from '../db/db.js';

const client = await pool.connect();
const qi = s => '"' + String(s).replaceAll('"', '""') + '"';
const nodes = [5, 8];
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '8000ms'");
  console.log('=== P0-C7B.3 / RICERCA NODI TERRITORIALI (READ ONLY) ===');
  const {rows: cols} = await client.query(`
    SELECT table_name, column_name, udt_name
    FROM information_schema.columns
    WHERE table_schema='public'
    ORDER BY table_name, ordinal_position
  `);
  const tables = new Map();
  for (const c of cols) {
    if (!tables.has(c.table_name)) tables.set(c.table_name, []);
    tables.get(c.table_name).push(c);
  }
  let matches=0;
  for (const [table, fields] of tables) {
    const names = new Set(fields.map(c=>c.column_name));
    const idCols = fields.filter(c => ['id','nodo_id','nodo_territoriale_id'].includes(c.column_name) && ['int2','int4','int8'].includes(c.udt_name));
    const geoCols = fields.filter(c => ['geometry','geography'].includes(c.udt_name));
    const lat = ['lat','latitude','latitudine'].find(n=>names.has(n));
    const lon = ['lon','lng','longitude','longitudine'].find(n=>names.has(n));
    if (!idCols.length || (!geoCols.length && !(lat && lon))) continue;
    if (!/(nodo|territor|fermat|hub|pixel)/i.test(table)) continue;
    for (const idCol of idCols) {
      const coordSql = geoCols.length
        ? `ST_Y(${qi(geoCols[0].column_name)}::geometry) AS lat, ST_X(${qi(geoCols[0].column_name)}::geometry) AS lon`
        : `${qi(lat)} AS lat, ${qi(lon)} AS lon`;
      const sql = `SELECT ${qi(idCol.column_name)} AS node_id, ${coordSql} FROM public.${qi(table)} WHERE ${qi(idCol.column_name)} = ANY($1::bigint[]) LIMIT 10`;
      try {
        // Savepoint so an incompatible spatial type cannot poison the read-only transaction.
        await client.query('SAVEPOINT candidate');
        const {rows} = await client.query(sql,[nodes]);
        await client.query('RELEASE SAVEPOINT candidate');
        for (const r of rows) {
          console.log(`TROVATO: ${table}.${idCol.column_name}=${r.node_id} lat=${r.lat} lon=${r.lon}`);
          matches++;
        }
      } catch(e) {
        await client.query('ROLLBACK TO SAVEPOINT candidate');
        await client.query('RELEASE SAVEPOINT candidate');
        console.log(`NON UTILIZZABILE: ${table}.${idCol.column_name}: ${e.message}`);
      }
    }
  }
  if (!matches) {
    console.log('NESSUNA COORDINATA DIRETTA: cercare la sorgente territoriale nel codice PIXEL.');
    console.log('NOTA: le coordinate delle richieste 196/205 non sono automaticamente quelle dei nodi.');
  }
  const {rows: requests} = await client.query(`
    SELECT id, origine_nodo_territoriale_id AS origine_nodo,
           destinazione_nodo_territoriale_id AS destinazione_nodo,
           ST_Y(origine::geometry) AS origine_lat, ST_X(origine::geometry) AS origine_lon,
           ST_Y(destinazione::geometry) AS destinazione_lat, ST_X(destinazione::geometry) AS destinazione_lon
    FROM public.richieste_pop_bus WHERE id = ANY($1::int[]) ORDER BY id`,[[196,205]]);
  console.log('\n=== COORDINATE RICHIESTE (RIFERIMENTO, NON NODI CERTIFICATI) ===');
  for(const r of requests) console.log(JSON.stringify(r));
  await client.query('ROLLBACK');
  console.log('\nROLLBACK READ ONLY. Nessuna chiamata Google Maps.');
} catch(e) {
  try { await client.query('ROLLBACK'); } catch {}
  console.error('ERRORE:',e.message);
  process.exitCode=1;
} finally {
  client.release();
  await pool.end();
}
