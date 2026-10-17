// TURENTU POPBUS — P0-E2B: AUDIT TRIGGER E VINCOLI REALI
// Copia in tests/test_popbus_P0E2B_trigger_audit_readonly.mjs
// Esegui: node tests/test_popbus_P0E2B_trigger_audit_readonly.mjs
// TRANSAZIONE READ ONLY. Nessuna modifica dati/schema, nessuna chiamata Stripe.
// Il report contiene definizioni SQL/PLpgSQL: verificare prima di condividerlo pubblicamente.

import { pool } from '../db/db.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tables = ['prenotazioni', 'veicolo', 'corse', 'pagamenti', 'popbus_attivazioni',
  'popbus_attivazione_missioni', 'popbus_missione_richieste', 'popbus_attivazione_richieste',
  'direttrici_virtuali', 'segmenti', 'disponibilita_veicolo'];
const targetFunctions = ['check_posti_disponibili_trigger', 'trg_refresh_indice_veicolo'];
const reportPath = resolve(process.cwd(), 'tests', 'P0E2B_trigger_audit_report.json');
let client;
let pass = 0, warn = 0;
const ok = message => { pass++; console.log(`PASS ${message}`); };
const warning = message => { warn++; console.log(`WARN ${message}`); };

try {
  console.log('=== POPBUS P0-E2B — TRIGGER E VINCOLI (READ ONLY) ===');
  client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '15000ms'");

  const triggers = (await client.query(`
    SELECT c.relname AS table_name, t.tgname AS trigger_name,
           t.tgenabled AS enabled_mode, t.tgisinternal AS internal,
           p.oid::regprocedure::text AS function_signature,
           pg_get_triggerdef(t.oid, true) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
    ORDER BY c.relname, t.tgname
  `, [tables])).rows;

  const functions = (await client.query(`
    SELECT n.nspname AS schema_name, p.proname AS function_name,
           p.oid::regprocedure::text AS signature,
           l.lanname AS language, p.prosecdef AS security_definer,
           pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
    ORDER BY p.proname, p.oid::regprocedure::text
  `, [targetFunctions])).rows;

  const constraints = (await client.query(`
    SELECT c.relname AS table_name, con.conname AS constraint_name,
           con.contype AS constraint_type, con.condeferrable AS deferrable,
           con.condeferred AS initially_deferred,
           pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
    ORDER BY c.relname, con.conname
  `, [tables])).rows;

  const indexes = (await client.query(`
    SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ANY($1::text[])
    ORDER BY tablename, indexname
  `, [tables])).rows;

  const report = {
    test: 'P0-E2B', mode: 'READ ONLY', generated_at: new Date().toISOString(),
    triggers, functions, constraints, indexes
  };
  await client.query('ROLLBACK');
  client.release();
  client = null;

  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`REPORT ${reportPath}`);
  ok(`Lettura cataloghi PostgreSQL: ${triggers.length} trigger, ${functions.length} funzioni, ${constraints.length} vincoli, ${indexes.length} indici`);

  for (const name of targetFunctions) {
    const matches = functions.filter(f => f.function_name === name);
    if (matches.length) ok(`Definizione recuperata: ${name} (${matches.length})`);
    else warning(`Funzione non trovata nello schema public: ${name}`);
  }
  for (const name of ['trg_check_posti', 'trg_veicolo_trig']) {
    const matches = triggers.filter(t => t.trigger_name === name);
    if (matches.length) ok(`Trigger recuperato: ${name}`);
    else warning(`Trigger non trovato: ${name}`);
  }
  const disabled = triggers.filter(t => t.enabled_mode === 'D');
  if (disabled.length) warning(`${disabled.length} trigger disabilitati (vedere report)`);
  else ok('Nessun trigger disabilitato nelle tabelle esaminate');

  console.log(`ESITO: ${pass} PASS, ${warn} WARN. SOLO LETTURA; nessun test di INSERT o concorrenza.`);
} catch (error) {
  if (client) {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
  }
  console.error('FAIL P0-E2B:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
