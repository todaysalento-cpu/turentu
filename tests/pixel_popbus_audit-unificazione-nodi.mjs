// TURENTU — Audit pre-migrazione nodi territoriali / POPBUS V2.
// SOLO LETTURA: SELECT su cataloghi PostgreSQL e scansione sorgenti locali.
// Eseguire: node --env-file=.env tests/pixel_popbus_audit-unificazione-nodi.mjs
import { pool } from '../db/db.js';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const TOKENS = /\b(nodi_direttrice|nodi_territoriali|start_node_id|end_node_id|origine_nodo_territoriale_id|destinazione_nodo_territoriale_id)\b/gi;
const EXCLUDE = new Set(['node_modules','.git','.expo','dist','build','coverage']);
const MAX_FILES = 15000;
const MAX_BYTES = 1_000_000;
const MAX_MATCHES = 180;

async function scan(root) {
  const found=[]; let inspected=0, skipped=0;
  async function walk(dir) {
    for (const e of await readdir(dir,{withFileTypes:true}).catch(()=>[])) {
      if (e.isDirectory()) {if(!EXCLUDE.has(e.name)) await walk(path.join(dir,e.name));continue;}
      if(!e.isFile() || !/\.(js|mjs|cjs|ts|tsx|sql)$/i.test(e.name))continue;
      if(++inspected>MAX_FILES)throw Error(`Limite scansione sorgenti ${MAX_FILES} raggiunto`);
      const p=path.join(dir,e.name);
      const {size}=await import('node:fs/promises').then(m=>m.stat(p));
      if(size>MAX_BYTES){skipped++;continue;}
      const lines=(await readFile(p,'utf8')).split(/\r?\n/);
      for(let i=0;i<lines.length;i++) {
        TOKENS.lastIndex=0;
        if(!TOKENS.test(lines[i]))continue;
        if(found.length<MAX_MATCHES)found.push({file:path.relative(ROOT,p),line:i+1,text:lines[i].trim().slice(0,190)});
      }
    }
  }
  for(const d of ['services','routes','workers','db','src'])await walk(path.join(root,d));
  return {filesInspected:inspected,oversizeSkipped:skipped,matchesShown:found.length,matches:found};
}

const queries = [
  ['COLONNE_NODI', `SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default
   FROM information_schema.columns WHERE table_schema='public'
     AND table_name IN ('nodi_direttrice','nodi_territoriali') ORDER BY table_name,ordinal_position`],
  ['FOREIGN_KEYS', `SELECT con.conname AS vincolo, con.conrelid::regclass::text AS tabella,
      con.confrelid::regclass::text AS riferisce,
      pg_get_constraintdef(con.oid) AS definizione
   FROM pg_constraint con WHERE con.contype='f'
     AND (con.conrelid IN (SELECT oid FROM pg_class WHERE relname IN ('nodi_direttrice','nodi_territoriali'))
       OR con.confrelid IN (SELECT oid FROM pg_class WHERE relname IN ('nodi_direttrice','nodi_territoriali')))
   ORDER BY tabella,vincolo`],
  ['COLONNE_ID_NODO', `SELECT table_name,column_name,data_type
   FROM information_schema.columns WHERE table_schema='public'
     AND (column_name ILIKE '%nodo%' OR column_name IN ('start_node_id','end_node_id'))
   ORDER BY table_name,column_name`],
  ['VINCOLI_CORRELATI', `SELECT con.conrelid::regclass::text AS tabella,con.conname AS nome,
      con.contype AS tipo,pg_get_constraintdef(con.oid) AS definizione
   FROM pg_constraint con WHERE con.connamespace='public'::regnamespace
     AND (pg_get_constraintdef(con.oid) ILIKE '%nodo%' OR con.conrelid::regclass::text IN ('nodi_direttrice','nodi_territoriali'))
   ORDER BY tabella,nome`],
  ['VIEW_DIPENDENTI', `SELECT schemaname,viewname,definition
   FROM pg_views WHERE schemaname='public'
     AND (definition ILIKE '%nodi_direttrice%' OR definition ILIKE '%nodi_territoriali%')
   ORDER BY viewname`],
  ['INDICI_NODI', `SELECT tablename,indexname,indexdef FROM pg_indexes
   WHERE schemaname='public' AND (tablename IN ('nodi_direttrice','nodi_territoriali')
      OR indexdef ILIKE '%start_node_id%' OR indexdef ILIKE '%end_node_id%')
   ORDER BY tablename,indexname`],
  ['FUNZIONI_DIPENDENTI', `SELECT n.nspname AS schema,p.proname AS funzione,
      pg_get_function_identity_arguments(p.oid) AS argomenti
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND (pg_get_functiondef(p.oid) ILIKE '%nodi_direttrice%'
     OR pg_get_functiondef(p.oid) ILIKE '%nodi_territoriali%') ORDER BY funzione`],
  ['TRIGGER', `SELECT event_object_table AS tabella,trigger_name,action_statement
   FROM information_schema.triggers WHERE trigger_schema='public'
     AND (event_object_table IN ('nodi_direttrice','nodi_territoriali')
       OR action_statement ILIKE '%nodi_direttrice%' OR action_statement ILIKE '%nodi_territoriali%')
   ORDER BY tabella,trigger_name`]
];

const client=await pool.connect();
try {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  console.log('=== TURENTU — AUDIT UNIFICAZIONE NODI (READ ONLY) ===');
  for(const [label,sql] of queries) {
    try {
      // SAVEPOINT non consentito in transazione READ ONLY? PostgreSQL lo consente.
      await client.query('SAVEPOINT audit_query');
      const {rows}=await client.query(sql);
      await client.query('RELEASE SAVEPOINT audit_query');
      console.log(`\n[${label}] righe=${rows.length}`);
      console.log(JSON.stringify(rows.slice(0,150),null,2));
      if(rows.length>150)console.log(`[TRONCATO] ${rows.length-150} righe ulteriori`);
    } catch(e) {
      await client.query('ROLLBACK TO SAVEPOINT audit_query');
      console.log(`[${label}] ERRORE: ${e.message}`);
    }
  }
  await client.query('ROLLBACK');
  console.log('\n[DB] Transazione READ ONLY terminata con ROLLBACK');
} catch(e) {
  await client.query('ROLLBACK').catch(()=>{});
  console.error('[ERRORE DB]',e.message);
  process.exitCode=1;
} finally {client.release();await pool.end();}
try {
  const result=await scan(ROOT);
  console.log('\n[SORGENTI LOCALI — riferimenti potenzialmente da migrare]');
  console.log(JSON.stringify(result,null,2));
  console.log('\n[NOTA] La scansione testuale non dimostra che tutti i riferimenti siano attivi; verificare SQL dinamico e servizi esterni.');
} catch(e) {console.error('[ERRORE SCANSIONE]',e.message);process.exitCode=1;}
console.log('\nNESSUNA MODIFICA AL DATABASE O AI FILE DEL PROGETTO.');
