// TURENTU POPBUS — P0-E2A / DIAGNOSTICA SCHEMA POSTGRESQL REALE
// Salva come tests/test_popbus_P0E2A_schema_readonly.mjs
// Esegui dalla root: node tests/test_popbus_P0E2A_schema_readonly.mjs
// SOLA LETTURA: BEGIN READ ONLY; nessun INSERT/UPDATE/DELETE/DDL; nessuna chiamata Stripe.
// Usa il pool gia' presente in ../db/db.js. Non stampa credenziali.

import { pool } from '../db/db.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TABLES = [
  'veicolo', 'disponibilita_veicolo', 'richieste_pop_bus',
  'popbus_attivazioni', 'popbus_attivazione_missioni',
  'popbus_missione_richieste', 'popbus_attivazione_richieste',
  'offerte_autisti', 'corse', 'prenotazioni', 'pagamenti',
  'direttrici_virtuali', 'segmenti'
];
const REPORT_PATH = resolve(process.cwd(), 'tests', 'P0E2A_schema_report.json');
let client;
let pass = 0, fail = 0, warn = 0;
const check = (ok, message) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
  ok ? pass++ : fail++;
};
const warning = message => { warn++; console.log(`WARN ${message}`); };
const key = (table, column) => `${table}.${column}`;

try {
  console.log('=== TURENTU POPBUS P0-E2A / SCHEMA REALE IN SOLA LETTURA ===');
  client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '15000ms'");

  const identity = await client.query(`
    SELECT current_database() AS database, current_user AS username,
           current_schema() AS schema, current_setting('server_version') AS pg_version
  `);
  const columns = (await client.query(`
    SELECT table_name, ordinal_position, column_name, data_type, udt_name,
           is_nullable, column_default, character_maximum_length,
           is_identity, identity_generation, is_generated
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `, [TABLES])).rows;
  const constraints = (await client.query(`
    SELECT t.relname AS table_name, c.conname AS constraint_name,
           c.contype AS constraint_type, pg_get_constraintdef(c.oid, true) AS definition,
           CASE WHEN c.confrelid <> 0 THEN c.confrelid::regclass::text ELSE NULL END AS references_table,
           c.condeferrable AS deferrable, c.condeferred AS initially_deferred
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = ANY($1::text[])
    ORDER BY t.relname, c.conname
  `, [TABLES])).rows;
  const indexes = (await client.query(`
    SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ANY($1::text[])
    ORDER BY tablename, indexname
  `, [TABLES])).rows;
  const triggers = (await client.query(`
    SELECT event_object_table AS table_name, trigger_name, event_manipulation AS event,
           action_timing AS timing, action_statement AS action
    FROM information_schema.triggers
    WHERE trigger_schema = 'public' AND event_object_table = ANY($1::text[])
    ORDER BY event_object_table, trigger_name
  `, [TABLES])).rows;
  const tables = (await client.query(`
    SELECT c.relname AS table_name, c.relrowsecurity AS row_security,
           c.relforcerowsecurity AS force_row_security, c.relpersistence AS persistence
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND c.relname = ANY($1::text[])
    ORDER BY c.relname
  `, [TABLES])).rows;
  const functions = (await client.query(`
    SELECT p.proname AS function_name,
           pg_get_function_identity_arguments(p.oid) AS arguments,
           pg_get_function_result(p.oid) AS returns
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname ILIKE '%popbus%' OR p.proname ILIKE '%attivazion%')
    ORDER BY p.proname
  `)).rows;
  const report = {
    test: 'P0-E2A', mode: 'READ ONLY', generated_at: new Date().toISOString(),
    connection: identity.rows[0], tables, columns, constraints, indexes, triggers, functions
  };

  const present = new Set(tables.map(t => t.table_name));
  for (const table of TABLES) check(present.has(table), `Tabella public.${table}`);
  const presentCols = new Set(columns.map(c => key(c.table_name, c.column_name)));
  for (const [table, column] of [
    ['veicolo', 'id'], ['veicolo', 'driver_id'],
    ['popbus_attivazioni', 'id'], ['popbus_attivazioni', 'veicolo_id'],
    ['popbus_attivazioni', 'stato'], ['offerte_autisti', 'id'],
    ['corse', 'id'], ['prenotazioni', 'id'], ['pagamenti', 'id'],
    ['direttrici_virtuali', 'id'], ['direttrici_virtuali', 'veicolo_id'],
    ['segmenti', 'direttrice_id'], ['segmenti', 'start_datetime'],
    ['segmenti', 'tempo_stimato'], ['disponibilita_veicolo', 'veicolo_id']
  ]) check(presentCols.has(key(table, column)), `Colonna ${table}.${column}`);

  const critical = [
    ['popbus_attivazioni', 'direttrice_id'],
    ['direttrici_virtuali', 'partenza_prevista'],
    ['direttrici_virtuali', 'stato'],
    ['popbus_attivazioni', 'busy_start'],
    ['popbus_attivazioni', 'busy_end']
  ];
  for (const [table, column] of critical) {
    if (!presentCols.has(key(table, column))) warning(`Colonna da verificare nel codice: ${table}.${column}`);
  }

  const fk = constraints.filter(c => c.constraint_type === 'f');
  const uniques = constraints.filter(c => c.constraint_type === 'u' || c.constraint_type === 'p');
  console.log(`SCHEMA ${identity.rows[0].database} | PostgreSQL ${identity.rows[0].pg_version}`);
  console.log(`DETTAGLIO ${columns.length} colonne | ${constraints.length} vincoli (${fk.length} FK, ${uniques.length} PK/UNIQUE) | ${indexes.length} indici | ${triggers.length} trigger`);
  for (const t of TABLES) {
    const cols = columns.filter(c => c.table_name === t);
    console.log(`TABELLA ${t}: ${cols.length} colonne, ${constraints.filter(c => c.table_name === t).length} vincoli, ${indexes.filter(i => i.table_name === t).length} indici`);
  }
  if (triggers.length) warning('Trigger presenti: valutare effetti collaterali prima del test di acceptance');
  if (tables.some(t => t.row_security)) warning('RLS presente: valutare privilegi del pool');

  await client.query('ROLLBACK');
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`REPORT SALVATO: ${REPORT_PATH}`);
  console.log(`ESITO: ${pass} PASS, ${fail} FAIL, ${warn} WARN. SOLO LETTURA. Nessuna scrittura applicativa, nessuna chiamata Stripe.`);
  if (fail) process.exitCode = 1;
} catch (err) {
  console.error(`ERRORE P0-E2A: ${err.message}`);
  process.exitCode = 1;
  if (client) { try { await client.query('ROLLBACK'); } catch {} }
} finally {
  client?.release();
  await pool.end();
}
