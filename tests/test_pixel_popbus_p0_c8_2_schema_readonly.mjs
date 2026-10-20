// P0-C8.2: preflight di schema, esclusivamente SELECT. Nessuna scrittura.
import { pool } from '../db/db.js';
import fs from 'node:fs';

const tables = [
  'popbus_attivazioni', 'offerte_autisti', 'popbus_attivazione_missioni',
  'popbus_missione_richieste', 'popbus_attivazione_richieste',
  'richieste_pop_bus', 'transazioni_wallet', 'corse', 'prenotazioni', 'pagamenti'
];
let client;
try {
  const asm = fs.readFileSync('services/popbus/v2/popbus-single-corsa-assembler.js', 'utf8');
  console.log('=== ASSEMBLER: contratto statico ===');
  for (const term of ['CICLO_PIXEL_CORSA_UNICA_V1', 'missioni:', 'evaluation:', 'requestSnapshot', 'busyStart', 'busyEnd']) {
    console.log(`${asm.includes(term) ? 'PRESENTE' : 'DA VERIFICARE'} ${term}`);
  }
  client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  const columns = await client.query(`
    SELECT table_name, ordinal_position, column_name, data_type, is_nullable,
           column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position`, [tables]);
  const constraints = await client.query(`
    SELECT c.conrelid::regclass::text AS tabella, c.conname AS nome,
           c.contype AS tipo, pg_get_constraintdef(c.oid) AS definizione
    FROM pg_constraint c
    WHERE c.conrelid IN (
      SELECT cls.oid FROM pg_class cls JOIN pg_namespace ns ON ns.oid = cls.relnamespace
      WHERE ns.nspname='public' AND cls.relname = ANY($1::text[])
    ) ORDER BY 1,2`, [tables]);
  const triggers = await client.query(`
    SELECT event_object_table AS tabella, trigger_name AS nome,
           action_timing AS fase, event_manipulation AS evento,
           action_statement AS azione
    FROM information_schema.triggers
    WHERE trigger_schema='public' AND event_object_table = ANY($1::text[])
    ORDER BY 1,2`, [tables]);
  const found = new Set(columns.rows.map(r => r.table_name));
  console.log('\n=== TABELLE ===');
  for (const name of tables) console.log(`${found.has(name) ? 'OK' : 'ASSENTE'} ${name}`);
  console.log('\n=== COLONNE (obbligatorie marcate NOT NULL) ===');
  for (const r of columns.rows) console.log(`${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable === 'NO' ? 'NOT NULL' : ''} ${r.column_default == null ? '' : 'DEFAULT=' + r.column_default}`);
  console.log('\n=== VINCOLI ===');
  for (const r of constraints.rows) console.log(`${r.tabella} | ${r.nome} | ${r.tipo} | ${r.definizione}`);
  console.log('\n=== TRIGGER ===');
  for (const r of triggers.rows) console.log(`${r.tabella} | ${r.nome} | ${r.fase} ${r.evento} | ${r.azione}`);
  await client.query('ROLLBACK');
  console.log('\nP0-C8.2: LETTURA COMPLETATA. Nessuna scrittura eseguita.');
} catch (error) {
  console.error('P0-C8.2 ERRORE:', error.message);
  process.exitCode = 1;
  if (client) { try { await client.query('ROLLBACK'); } catch {} }
} finally {
  client?.release();
  await pool.end();
}
