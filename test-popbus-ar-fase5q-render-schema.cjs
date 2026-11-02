'use strict';
// Fase 5Q: raccolta metadati per fixture REALI, senza scritture applicative.
// Non chiama PIXEL, Stripe o finalizzaAttivazioniAR.
const fs = require('node:fs');
const { Client } = require('pg');
const tables = ['utente','veicolo','disponibilita_veicolo','ar_gruppi','richieste_pop_bus','popbus_attivazioni','popbus_attivazione_richieste','offerte_autisti','popbus_ar_accettazioni','pixel_opportunita','pixel_direttrici','transazioni_wallet','corse','prenotazioni','pagamenti'];
const fail = msg => { throw new Error('5Q SAFETY: ' + msg); };
if (process.env.TURENTU_TEST_AR_CONFIRM !== 'ROLLBACK_ONLY') fail('impostare TURENTU_TEST_AR_CONFIRM=ROLLBACK_ONLY');
const url = process.env.DATABASE_URL || process.env.TURENTU_TEST_DATABASE_URL;
if (!url) fail('DATABASE_URL o TURENTU_TEST_DATABASE_URL mancante');
(async () => {
  const db = new Client({ connectionString: url, application_name: 'turentu_5q_schema_readonly' });
  let tx = false;
  try {
    await db.connect();
    await db.query('BEGIN READ ONLY'); tx = true;
    await db.query("SET LOCAL statement_timeout = '12000ms'");
    const identity = await db.query('SELECT current_database() AS db, current_user AS role');
    const cols = await db.query(`SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default,ordinal_position
      FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1::text[])
      ORDER BY table_name,ordinal_position`, [tables]);
    const cons = await db.query(`SELECT c.relname AS table_name, con.conname AS name, con.contype AS kind,
      pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con
      JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,con.conname`, [tables]);
    const trg = await db.query(`SELECT event_object_table AS table_name, trigger_name, action_timing, event_manipulation
      FROM information_schema.triggers WHERE event_object_schema='public' AND event_object_table=ANY($1::text[])
      ORDER BY event_object_table,trigger_name`, [tables]);
    const report = { purpose:'5Q fixture schema blueprint, READ ONLY', generatedAt:new Date().toISOString(),
      database:identity.rows[0].db, role:identity.rows[0].role,
      columns:cols.rows, constraints:cons.rows, triggers:trg.rows };
    const file='turentu-fase5q-render-schema.json';
    fs.writeFileSync(file, JSON.stringify(report,null,2));
    console.log('PASS: schema Render letto in transazione READ ONLY');
    console.log('Tabelle rilevate:', new Set(cols.rows.map(x=>x.table_name)).size, '/', tables.length);
    console.log('Colonne:', cols.rowCount, 'Vincoli:', cons.rowCount, 'Trigger:', trg.rowCount);
    console.log('Report locale:', file);
  } finally {
    if (tx) { try { await db.query('ROLLBACK'); console.log('ROLLBACK OK'); } catch (e) { console.error('ROLLBACK FALLITO:',e.message); process.exitCode=2; } }
    try { await db.end(); } catch (_) {}
  }
})().catch(e=>{ console.error('STOP:',e.message); process.exitCode=1; });
