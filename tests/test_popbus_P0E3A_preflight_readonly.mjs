/**
 * TURENTU POPBUS P0-E3A — Preflight acceptance multimissione (SOLO LETTURA).
 * Salva in tests/test_popbus_P0E3A_preflight_readonly.mjs
 * Esegui: node tests/test_popbus_P0E3A_preflight_readonly.mjs
 * Non chiama accettaAttivazione, Stripe, BEGIN write, né modifica tabelle.
 */
import { pool } from '../db/db.js';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = join(here, 'P0E3A_preflight_report.json');
const report = { test: 'P0-E3A', mode: 'READ ONLY', timestamp: new Date().toISOString(), checks: [], observations: {}, warnings: [] };
let passes = 0, fails = 0;
const check = (ok, name, detail = '') => {
  report.checks.push({ status: ok ? 'PASS' : 'FAIL', name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? passes++ : fails++;
};
const warn = (message) => { report.warnings.push(message); console.log('WARN ' + message); };
const tables = ['corse','prenotazioni','pagamenti','popbus_attivazioni','popbus_attivazione_missioni','popbus_missione_richieste','popbus_attivazione_richieste','offerte_autisti','richieste_pop_bus','disponibilita_veicolo','veicolo'];
let client;
console.log('=== TURENTU POPBUS P0-E3A — PREFLIGHT ACCEPTANCE (READ ONLY) ===');
try {
  client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '15000ms'");
  const db = await client.query('SELECT current_database() AS db, current_user AS role');
  check(true, 'Connessione PostgreSQL in transazione READ ONLY', db.rows[0].db);
  const cols = await client.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position`, [tables]);
  const columnMap = Object.fromEntries(tables.map(t => [t, cols.rows.filter(c => c.table_name === t).map(c => c.column_name)]));
  report.observations.columns = columnMap;
  for (const table of tables) check(columnMap[table].length > 0, `Tabella ${table} presente`);
  const required = {
    corse: ['id','veicolo_id','start_datetime','arrivo_datetime','posti_totali','posti_disponibili','posti_prenotati','percorso_polyline','fermate_pianificate'],
    prenotazioni: ['id','corsa_id','cliente_id','posti_richiesti','start_offset','end_offset','start_index_polyline','end_index_polyline'],
    pagamenti: ['prenotazione_id','corsa_id','importo','stato','stripe_payment_intent'],
    popbus_attivazioni: ['id','veicolo_id','stato','piano','corsa_id','partenza','arrivo'],
    offerte_autisti: ['id','attivazione_id','autista_id','stato','expires_at'],
    richieste_pop_bus: ['id','stato','corsa_id','payment_intent_id'],
  };
  for (const [table, names] of Object.entries(required)) {
    const missing = names.filter(n => !columnMap[table].includes(n));
    check(missing.length === 0, `Colonne acceptance: ${table}`, missing.length ? `Mancano: ${missing.join(', ')}` : 'compatibili');
  }
  const triggers = await client.query(`SELECT t.tgname, pg_get_triggerdef(t.oid) AS definition,
      pg_get_functiondef(t.tgfoid) AS function_definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='prenotazioni' AND t.tgname='trg_check_posti' AND NOT t.tgisinternal`);
  const trg = triggers.rows[0];
  check(Boolean(trg), 'Trigger capacità presente');
  check(Boolean(trg && /BEFORE INSERT OR UPDATE OF/i.test(trg.definition)), 'Trigger protegge INSERT e UPDATE');
  check(Boolean(trg && /OLD\.id|excluded_id/i.test(trg.function_definition)), 'Funzione esclude la vecchia riga in UPDATE');
  report.observations.trigger = trg?.definition ?? null;
  const constraints = await client.query(`SELECT c.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND con.contype IN ('c','u','f')
    ORDER BY c.relname,con.conname`, [tables]);
  report.observations.constraints = constraints.rows;
  check(constraints.rows.some(r => r.table_name === 'popbus_attivazioni' && /stato/i.test(r.name)), 'Vincolo stato attivazione presente');
  const indexes = await client.query(`SELECT tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename,indexname`, [tables]);
  report.observations.indexes = indexes.rows;
  check(indexes.rows.some(r => r.tablename === 'popbus_attivazione_richieste' && /UNIQUE/i.test(r.indexdef) && /richiesta_id/i.test(r.indexdef) && /WHERE/i.test(r.indexdef)), 'Unicità prenotazione richiesta attiva presente');
  const statusCols = cols.rows.filter(c => ['prenotazioni','pagamenti','richieste_pop_bus'].includes(c.table_name) && /stato|status|annull|cancel|rimbor|refund/i.test(c.column_name));
  report.observations.status_columns = statusCols;
  if (!columnMap.prenotazioni.includes('stato')) warn('prenotazioni.stato assente: chiarire cancellazioni e rilascio posti prima di acceptance live');
  const sourcePaths = [resolve(here, '../services/popbus/acceptance.js'), resolve(here, '../services/acceptance.js'), resolve(here, '../acceptance.js')];
  const sourcePath = sourcePaths.find(existsSync);
  if (sourcePath) {
    const source = readFileSync(sourcePath,'utf8');
    report.observations.acceptance_source = sourcePath;
    check(/export\s+async\s+function\s+accettaAttivazione/.test(source), 'Funzione accettaAttivazione trovata');
    check(/POPBUS_MULTIMISSION_ACCEPTANCE_TEST/.test(source), 'Flag sperimentale multimissione nel codice');
    if (/paymentIntents\.retrieve|new Stripe\(/.test(source)) warn('Acceptance contiene accesso Stripe: NON chiamare direttamente in questo preflight');
    if (/UPDATE\s+corse[\s\S]{0,180}posti_prenotati\s*=/.test(source)) warn('Verificare semantica posti_prenotati: somma passeggeri vs picco segmentale');
  } else {
    warn('Sorgente acceptance.js non trovata nei percorsi comuni: verifica statica non eseguita');
  }
  const env = process.env.POPBUS_MULTIMISSION_ACCEPTANCE_TEST;
  report.observations.multimission_flag = env === undefined ? 'unset' : env;
  if (env === '1' || env === 'true') warn('Flag multimissione ATTIVO in questo processo: mantenerlo disabilitato per preflight');
  else check(true, 'Flag multimissione non abilitato nel processo di test');
  await client.query('ROLLBACK');
  check(true, 'Transazione READ ONLY terminata con ROLLBACK');
} catch (e) {
  fails++;
  console.error('FAIL ERRORE:', e.message);
  report.error = { message: e.message, code: e.code ?? null };
  if (client) { try { await client.query('ROLLBACK'); } catch {} }
} finally {
  if (client) client.release();
  await pool.end();
  report.summary = { passes, fails, warnings: report.warnings.length };
  writeFileSync(reportPath, JSON.stringify(report,null,2));
  console.log('REPORT',reportPath);
  console.log(`ESITO: ${passes} PASS, ${fails} FAIL, ${report.warnings.length} WARN. SOLO LETTURA. ZERO STRIPE.`);
  if (fails) process.exitCode=1;
}
