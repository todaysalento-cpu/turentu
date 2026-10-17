// TURENTU — audit dipendenze dati POPBUS, rigorosamente READ ONLY.
// Eseguire: node --env-file=.env tests/audit_pulizia_popbus.mjs
import { pool } from '../db/db.js';

const roots = [
  'richieste_pop_bus', 'direttrici_virtuali', 'segmenti',
  'missioni_ritorno', 'nodi_direttrice',
];
const client = await pool.connect();
const print = (name, data) => {
  console.log(`\n[${name}]`);
  console.log(JSON.stringify(data, null, 2));
};
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '15000ms'");
  const fk = await client.query(`
    SELECT con.conname AS vincolo,
           child_ns.nspname AS schema_figlio,
           child.relname AS tabella_figlia,
           parent_ns.nspname AS schema_padre,
           parent.relname AS tabella_padre,
           pg_get_constraintdef(con.oid) AS definizione,
           con.confdeltype AS on_delete_codice
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE con.contype = 'f'
      AND child_ns.nspname NOT IN ('pg_catalog', 'information_schema')
      AND parent_ns.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY schema_padre, tabella_padre, schema_figlio, tabella_figlia, vincolo
  `);
  const incoming = new Map();
  for (const f of fk.rows) {
    const parent = `${f.schema_padre}.${f.tabella_padre}`;
    if (!incoming.has(parent)) incoming.set(parent, []);
    incoming.get(parent).push(f);
  }
  const queue = roots.map(t => `public.${t}`);
  const seen = new Set();
  const edges = [];
  while (queue.length) {
    const table = queue.shift();
    if (seen.has(table)) continue;
    seen.add(table);
    for (const f of incoming.get(table) ?? []) {
      edges.push(f);
      const child = `${f.schema_figlio}.${f.tabella_figlia}`;
      if (!seen.has(child)) queue.push(child);
    }
  }
  print('TABELLE_RAGGIUNGIBILI_DA_FK', [...seen].sort());
  print('VINCOLI_FK_ENTRANTI_RICORSIVI', edges);
  const counts = [];
  for (const qualified of [...seen].sort()) {
    const [schema, table] = qualified.split('.');
    const exists = await client.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p')`,
      [schema, table],
    );
    if (!exists.rowCount) {
      counts.push({ tabella: qualified, errore: 'non tabella ordinaria/partizionata' });
      continue;
    }
    const q = s => `"${s.replaceAll('"', '""')}"`;
    const res = await client.query(`SELECT count(*)::text AS totale FROM ${q(schema)}.${q(table)}`);
    counts.push({ tabella: qualified, totale: res.rows[0].totale });
  }
  print('CONTEGGI_TABELLE_DIPENDENTI', counts);
  const fn = await client.query(`
    SELECT n.nspname AS schema, p.proname AS funzione,
           pg_get_function_identity_arguments(p.oid) AS argomenti,
           pg_get_functiondef(p.oid) AS definizione
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      AND p.prokind='f'
      AND (pg_get_functiondef(p.oid) ILIKE '%nodi_direttrice%'
        OR pg_get_functiondef(p.oid) ILIKE '%get_or_create_node%')
    ORDER BY n.nspname,p.proname
  `);
  print('FUNZIONI_LEGACY', fn.rows);
  await client.query('ROLLBACK');
  console.log('\nFINE: audit in sola lettura, nessuna cancellazione.');
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  console.error('[ERRORE]', error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
