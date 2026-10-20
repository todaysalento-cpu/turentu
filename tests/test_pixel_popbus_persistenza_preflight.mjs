// TURENTU — P0-C4: preflight DB SOLO LETTURA, transazione ROLLBACK.
// Non chiama registraMissioniAttivazione e non inserisce righe.
// Eseguire dopo aver rinominato .txt in .mjs nella cartella tests.
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';

const tables = {
  popbus_attivazioni: ['id'],
  popbus_attivazione_missioni: ['id', 'attivazione_id', 'ordine', 'direttrice_id', 'corridoio_pixel_id', 'nodi_territoriali', 'partenza', 'arrivo', 'piano'],
  popbus_missione_richieste: ['missione_id', 'richiesta_id', 'indice_salita', 'indice_discesa'],
  popbus_attivazione_richieste: ['attivazione_id', 'richiesta_id', 'indice_salita', 'indice_discesa'],
};

const client = await pool.connect();
let failed = false;
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '10000ms'");
  const { rows } = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `, [Object.keys(tables)]);
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.table_name)) grouped.set(row.table_name, new Map());
    grouped.get(row.table_name).set(row.column_name, row);
  }
  for (const [table, cols] of Object.entries(tables)) {
    const actual = grouped.get(table);
    console.log(`\n${table}: ${actual?.size ?? 0} colonne rilevate`);
    assert.ok(actual, `Tabella mancante: public.${table}`);
    for (const col of cols) {
      assert.ok(actual.has(col), `Colonna mancante: ${table}.${col}`);
      console.log(`  OK ${col}: ${actual.get(col).data_type}`);
    }
  }
  const { rows: constraints } = await client.query(`
    SELECT conrelid::regclass::text AS tabella, conname AS vincolo,
           contype AS tipo, pg_get_constraintdef(oid) AS definizione
    FROM pg_constraint
    WHERE conrelid IN (
      'public.popbus_attivazioni'::regclass,
      'public.popbus_attivazione_missioni'::regclass,
      'public.popbus_missione_richieste'::regclass,
      'public.popbus_attivazione_richieste'::regclass
    )
    ORDER BY conrelid::regclass::text, conname
  `);
  console.log('\nVINCOLI ESISTENTI:');
  for (const c of constraints) console.log(`${c.tabella} | ${c.vincolo} | ${c.tipo} | ${c.definizione}`);
  console.log('\nPRE-FLIGHT SUPERATO: schema minimo presente. Nessuna scrittura eseguita.');
} catch (e) {
  failed = true;
  console.error('\nPRE-FLIGHT FALLITO:', e.message);
} finally {
  try { await client.query('ROLLBACK'); console.log('ROLLBACK eseguito.'); }
  finally { client.release(); await pool.end(); }
}
if (failed) process.exitCode = 1;
