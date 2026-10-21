/**
 * POPBUS 5F.2 — preflight schema (SOLA LETTURA).
 * Salvare come tests/popbus-5f2-schema-readonly.js.
 * Non avvia worker, non scrive nel DB, non chiama Stripe.
 */
import 'dotenv/config';
import { pool } from '../db/db.js';

const TABLES = [
  'popbus_riserve',
  'popbus_payment_reconciliation',
  'prenotazioni',
  'pagamenti',
  'corse'
];

try {
  console.log('[POPBUS 5F.2] PRE-FLIGHT SOLA LETTURA');
  console.log('[POPBUS 5F.2] Nessun worker o servizio di riconciliazione invocato');
  const { rows: columns } = await pool.query(`
    SELECT table_name, ordinal_position, column_name, data_type,
           is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `, [TABLES]);
  for (const name of TABLES) {
    console.log(`\n=== public.${name} ===`);
    const entries = columns.filter(row => row.table_name === name);
    if (!entries.length) {
      console.log('Tabella non trovata oppure non visibile');
      continue;
    }
    console.table(entries.map(({ column_name, data_type, is_nullable, column_default }) => ({
      colonna: column_name, tipo: data_type, nullable: is_nullable,
      default: column_default
    })));
  }

  const { rows: constraints } = await pool.query(`
    SELECT cls.relname AS tabella, con.conname AS vincolo,
           con.contype AS tipo, pg_get_constraintdef(con.oid) AS definizione
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    WHERE ns.nspname = 'public' AND cls.relname = ANY($1::text[])
    ORDER BY cls.relname, con.conname
  `, [TABLES]);
  console.log('\n=== VINCOLI ===');
  console.table(constraints);

  const { rows: indexes } = await pool.query(`
    SELECT tablename AS tabella, indexname AS indice, indexdef AS definizione
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ANY($1::text[])
    ORDER BY tablename, indexname
  `, [TABLES]);
  console.log('\n=== INDICI ===');
  console.table(indexes);
  console.log('\n[POPBUS 5F.2] PASS: introspezione completata, nessuna scrittura.');
} catch (error) {
  console.error('[POPBUS 5F.2] ERRORE:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
