// TURENTU FASE 5H - readiness per fixture A/R, SOLO LETTURA.
// Salvare come tests/test-popbus-ar-fase5h-prerequisiti.js
// Non crea dati e non invoca acceptance.js / Stripe / worker.
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL mancante');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
  max: 1, connectionTimeoutMillis: 10000,
  statement_timeout: 15000,
  application_name: 'turentu-fase5h-readonly'
});
const tables = [
  'ar_gruppi', 'richieste_pop_bus', 'popbus_attivazioni',
  'popbus_attivazione_richieste', 'popbus_ar_accettazioni',
  'offerte_autisti', 'corse', 'prenotazioni', 'pagamenti'
];
const client = await pool.connect();
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '15s'");
  const { rows: columns } = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `, [tables]);
  const found = new Set(columns.map(x => x.table_name));
  console.log('TURENTU FASE 5H - PREREQUISITI FIXTURE A/R (READ ONLY)');
  for (const table of tables) {
    const cols = columns.filter(x => x.table_name === table);
    console.log(`\n${table}: ${found.has(table) ? 'PRESENTE' : 'ASSENTE'} (${cols.length} colonne)`);
    if (cols.length) console.log(cols.map(c => `  ${c.column_name}: ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}${c.column_default ? ' DEFAULT' : ''}`).join('\n'));
  }
  const { rows: constraints } = await client.query(`
    SELECT c.conrelid::regclass::text AS tabella, c.conname AS nome,
           c.contype AS tipo, pg_get_constraintdef(c.oid) AS definizione
    FROM pg_constraint c
    WHERE c.conrelid IN (
      SELECT oid FROM pg_class WHERE relname = ANY($1::text[])
        AND relnamespace = current_schema()::regnamespace
    ) AND c.contype IN ('f','c','u','p')
    ORDER BY tabella, nome
  `, [tables]);
  console.log('\nVINCOLI (PK / UNIQUE / FK / CHECK)');
  for (const c of constraints) console.log(`${c.tabella} | ${c.nome} | ${c.definizione}`);
  const { rows: triggers } = await client.query(`
    SELECT event_object_table AS tabella, trigger_name AS nome,
           action_timing AS momento, event_manipulation AS evento
    FROM information_schema.triggers
    WHERE trigger_schema = current_schema() AND event_object_table = ANY($1::text[])
    ORDER BY tabella, nome
  `, [tables]);
  console.log('\nTRIGGER APPLICATIVI');
  if (!triggers.length) console.log('Nessun trigger visibile');
  for (const t of triggers) console.log(`${t.tabella} | ${t.nome} | ${t.momento} ${t.evento}`);
  await client.query('ROLLBACK');
  console.log('\nFASE 5H: inventario completato. NESSUNA SCRITTURA.');
} catch (e) {
  try { await client.query('ROLLBACK'); } catch {}
  console.error('FASE 5H FALLITA:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
