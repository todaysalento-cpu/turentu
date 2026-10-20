// TURENTU P0-C8.19C — Audit offerte PIXEL-first, sola lettura.
// Posizionare in tests/ e avviare con: node --env-file=.env tests/test_pixel_popbus_p0_c8_19c_offerte_readonly.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tables = ['offerte_autisti', 'popbus_attivazioni', 'popbus_attivazione_missioni', 'popbus_attivazione_richieste', 'richieste_pop_bus', 'popbus_missione_richieste'];
const check = (ok, label) => { assert.ok(ok, label); console.log('PASS ' + label); };
const fmt = value => JSON.stringify(value, (_k,v) => typeof v === 'bigint' ? String(v) : v);
const client = await pool.connect();
let tx = false;
try {
  console.log('=== P0-C8.19C / OFFERTE PIXEL-FIRST / READ ONLY ===');
  await client.query('BEGIN TRANSACTION READ ONLY'); tx = true;
  await client.query("SET LOCAL statement_timeout = '12000ms'");
  await client.query("SET LOCAL lock_timeout = '2000ms'");
  const { rows: cols } = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1::text[])
    ORDER BY table_name, ordinal_position`, [tables]);
  for (const table of tables) {
    const c = cols.filter(x => x.table_name === table);
    check(c.length > 0, `Tabella ${table} presente`);
    console.log(`\nCOLONNE ${table}:`);
    for (const x of c) console.log(`  ${x.column_name} ${x.data_type} ${x.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}${x.column_default ? ' DEFAULT '+x.column_default : ''}`);
  }
  const { rows: constraints } = await client.query(`
    SELECT t.relname AS tabella, c.conname AS nome, c.contype AS tipo,
           pg_get_constraintdef(c.oid) AS definizione
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname=ANY($1::text[])
    ORDER BY t.relname, c.conname`, [tables]);
  console.log('\nVINCOLI OFFERTA / ATTIVAZIONE / MAPPING:');
  for (const x of constraints.filter(x => ['offerte_autisti','popbus_attivazioni','popbus_attivazione_richieste'].includes(x.tabella))) {
    console.log(`  ${x.tabella}.${x.nome}: ${x.definizione}`);
  }
  const offerCols = cols.filter(x=>x.table_name==='offerte_autisti');
  const has = (t,c) => cols.some(x=>x.table_name===t && x.column_name===c);
  const requiredLegacy = offerCols.find(x=>x.column_name==='direttrice_id');
  const canNullLegacy = requiredLegacy?.is_nullable === 'YES';
  console.log('\nCONTRATTO PIXEL-FIRST:');
  console.log('  offerte_autisti.attivazione_id:', has('offerte_autisti','attivazione_id') ? 'PRESENTE' : 'ASSENTE');
  console.log('  offerte_autisti.direttrice_id:', requiredLegacy ? (canNullLegacy ? 'NULL AMMESSO' : 'NOT NULL') : 'ASSENTE');
  console.log('  offerte_autisti.pixel_opportunita_id:', has('offerte_autisti','pixel_opportunita_id') ? 'PRESENTE' : 'ASSENTE');
  console.log('  popbus_attivazioni.pixel_opportunita_id:', has('popbus_attivazioni','pixel_opportunita_id') ? 'PRESENTE' : 'ASSENTE');
  console.log('  popbus_attivazione_missioni.pixel_opportunita_id:', has('popbus_attivazione_missioni','pixel_opportunita_id') ? 'PRESENTE' : 'ASSENTE');
  console.log('  popbus_attivazione_missioni.corridoio_pixel_id:', has('popbus_attivazione_missioni','corridoio_pixel_id') ? 'PRESENTE' : 'ASSENTE');
  check(has('offerte_autisti','attivazione_id'), 'Offerta collegabile a una attivazione');
  check(has('popbus_attivazione_missioni','pixel_opportunita_id'), 'Missioni collegabili alle opportunita PIXEL');
  if (requiredLegacy && !canNullLegacy) console.log('BLOCCO: direttrice_id obbligatoria sulle offerte; NON usare ID legacy fittizi');
  else console.log('NOTA: la nullabilita di direttrice_id non dimostra da sola compatibilita dei consumer');

  const files = [
    'services/popbus/v2/worker.js',
    'services/popbus/v2/acceptance.js',
    'services/popbus/v2/popbus-cycle-persistence.js',
    'services/popbus/v2/pixel-first-transaction-STAGING.js'
  ];
  console.log('\nAUDIT STATICO PUNTI DI INTEGRAZIONE:');
  for (const f of files) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) { console.log(`  NON TROVATO ${f}`); continue; }
    const lines = fs.readFileSync(p,'utf8').split(/\r?\n/);
    const patterns = /POPBUS_PIXEL_FIRST|POPBUS_MULTIMISSION_ACCEPTANCE_TEST|INSERT INTO offerte_autisti|INSERT INTO popbus_attivazioni|accettaAttivazione|registraMissioniAttivazione|economicamenteAttivabile|pixel_opportunita_id|direttrice_id/i;
    console.log(`  ${f}:`);
    const hits = lines.map((s,i)=>({s,i:i+1})).filter(x=>patterns.test(x.s));
    for (const x of hits.slice(0,45)) console.log(`    ${x.i}: ${x.s.trim().slice(0,180)}`);
    if (hits.length>45) console.log(`    ...altre ${hits.length-45} occorrenze`);
  }
  console.log('\nESITO: AUDIT READ ONLY COMPLETATO. Non certifica consumer, pagamenti o acceptance E2E.');
} catch (e) {
  console.error('FAIL', e.stack || e.message);
  process.exitCode=1;
} finally {
  if (tx) {
    try { await client.query('ROLLBACK'); console.log('ROLLBACK READ ONLY completato'); }
    catch(e) { console.error('ERRORE ROLLBACK',e.message); process.exitCode=1; }
  }
  client.release();
  await pool.end();
}
