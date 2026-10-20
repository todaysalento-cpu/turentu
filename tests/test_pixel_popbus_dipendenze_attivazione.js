// TURENTU - AUDIT READ-ONLY DIPENDENZE ATTIVAZIONE PIXEL-FIRST
// Salva come tests/test_pixel_popbus_dipendenze_attivazione.js
// CMD: node --env-file=.env tests\test_pixel_popbus_dipendenze_attivazione.js
// Non importa, non invoca il worker. Non scrive e non avvia socket/Stripe.
import { readFile } from 'node:fs/promises';
import { pool } from '../db/db.js';

const source = await readFile(new URL('../services/popbus/v2/worker.js', import.meta.url), 'utf8');
const positions = (regex) => [...source.matchAll(regex)].map(m => source.slice(0, m.index).split('\n').length);
const checks = {
  generatoreLegacy: positions(/\bgeneraCandidate\s*\(\s*requests\s*\)/g),
  selezioneOperativa: positions(/\bscegliAttivazioni\s*\(\s*feasible\s*\)/g),
  scritturaDirettriciLegacy: positions(/INSERT\s+INTO\s+direttrici_virtuali/gi),
  scritturaSegmentiLegacy: positions(/INSERT\s+INTO\s+segmenti\s*\(/gi),
  scritturaAttivazioni: positions(/INSERT\s+INTO\s+popbus_attivazioni\s*\(/gi),
  scritturaOfferte: positions(/INSERT\s+INTO\s+offerte_autisti\s*\(/gi),
  scritturaRelazioniSegmenti: positions(/INSERT\s+INTO\s+popbus_attivazione_segmenti\s*\(/gi),
  updateRichiesteLegacy: positions(/UPDATE\s+richieste_pop_bus[\s\S]{0,150}?direttrice_id\s*=/gi),
  letturaAdapter: positions(/\bleggiContestiOpportunitaPixel\s*\(/g),
  registrazioneMissioni: positions(/\bregistraMissioniAttivazione\s*\(/g),
  commit: positions(/client\.query\s*\(\s*['"]COMMIT['"]\s*\)/g),
};
console.log('AUDIT_WORKER_JSON:' + JSON.stringify(checks));
let client;
try {
  client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='15000ms'");
  const tables = [
    'popbus_attivazioni','popbus_attivazione_missioni','popbus_attivazione_segmenti',
    'popbus_attivazione_richieste','popbus_missione_richieste','offerte_autisti',
    'richieste_pop_bus','direttrici_virtuali','segmenti','corse'
  ];
  const cols = await client.query(`
    SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1::text[])
      AND (column_name ~ '(direttrice|pixel|opportunita|segmento|missione|attivazione|corsa|veicolo|autista|stato)'
           OR is_nullable='NO')
    ORDER BY table_name,ordinal_position`, [tables]);
  const fks = await client.query(`
    SELECT t.relname AS tabella,c.conname AS vincolo,
           pg_get_constraintdef(c.oid) AS definizione
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname=ANY($1::text[])
      AND c.contype IN ('f','c')
    ORDER BY t.relname,c.conname`, [tables]);
  const triggers = await client.query(`
    SELECT event_object_table AS tabella,trigger_name,action_timing,
           event_manipulation,action_statement
    FROM information_schema.triggers
    WHERE trigger_schema='public' AND event_object_table=ANY($1::text[])
    ORDER BY event_object_table,trigger_name`, [tables]);
  console.log('AUDIT_COLONNE_JSON:' + JSON.stringify(cols.rows));
  console.log('AUDIT_VINCOLI_JSON:' + JSON.stringify(fks.rows));
  console.log('AUDIT_TRIGGER_JSON:' + JSON.stringify(triggers.rows));
  console.log('ESITO: audit read-only; nessuna attivazione effettuata.');
} catch (e) {
  console.error('AUDIT_ERROR:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (client) {
    try { await client.query('ROLLBACK'); console.log('ROLLBACK_OK'); }
    catch (e) { console.error('ROLLBACK_ERROR:', e.message); process.exitCode = 1; }
    client.release();
  }
  await pool.end();
}
