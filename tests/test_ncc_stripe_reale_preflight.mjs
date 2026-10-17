// TURENTU NCC - PRE-FLIGHT INTEGRAZIONE POSTGRESQL + STRIPE TEST
// Copia in tests/test_ncc_stripe_reale_preflight.mjs
// Esegui: node tests/test_ncc_stripe_reale_preflight.mjs
// SOLA LETTURA su PostgreSQL; NON crea o cattura PaymentIntent.
import 'dotenv/config';
import Stripe from 'stripe';
import { pool } from '../db/db.js';

let pass = 0, fail = 0, gap = 0;
function result(kind, message) {
  console.log(`${kind} ${message}`);
  if (kind === 'PASS') pass++;
  else if (kind === 'FAIL') fail++;
  else gap++;
}
const key = process.env.STRIPE_SECRET_KEY || '';
console.log('\nTURENTU NCC - PRE-FLIGHT STRIPE TEST + DB REALE (SOLA LETTURA)\n');
if (!key.startsWith('sk_test_')) {
  result('FAIL', 'STRIPE_SECRET_KEY deve iniziare con sk_test_. NON usare sk_live_.');
} else {
  result('PASS', 'Chiave Stripe di TEST presente (valore non mostrato)');
  try {
    const stripe = new Stripe(key);
    const account = await stripe.accounts.retrieve();
    result('PASS', `Connessione API Stripe riuscita; account ${account.id}; livemode=${account.charges_enabled === undefined ? 'n/d' : 'account'}`);
  } catch (e) { result('FAIL', `API Stripe: ${e.type || e.name}: ${e.message}`); }
}
let client;
try {
  client = await pool.connect();
  const db = await client.query('SELECT current_database() AS db, current_user AS usr, version() AS version');
  result('PASS', `PostgreSQL connesso: ${db.rows[0].db}, utente ${db.rows[0].usr}`);
  const tables = ['corse','prenotazioni','pagamenti','veicolo','utente','tariffe'];
  for (const table of tables) {
    const r = await client.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
    if (!r.rows.length) { result('FAIL', `Tabella public.${table} non trovata`); continue; }
    result('PASS', `Schema public.${table} (${r.rows.length} colonne)`);
    console.log(JSON.stringify({table, columns:r.rows}, null, 2));
  }
  const fks = await client.query(`SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name=ccu.constraint_name AND tc.table_schema=ccu.table_schema
    WHERE tc.table_schema='public' AND tc.constraint_type='FOREIGN KEY' AND tc.table_name IN ('corse','prenotazioni','pagamenti')
    ORDER BY tc.table_name, kcu.column_name`);
  console.log('\nFOREIGN KEYS:', JSON.stringify(fks.rows, null, 2));
  const checks = await client.query(`SELECT conrelid::regclass::text AS tabella, conname, pg_get_constraintdef(oid) AS definizione
    FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype='c'
      AND conrelid IN ('public.corse'::regclass,'public.prenotazioni'::regclass,'public.pagamenti'::regclass)
    ORDER BY 1,2`);
  console.log('\nCHECK CONSTRAINTS:', JSON.stringify(checks.rows, null, 2));
  const candidates = await client.query(`SELECT v.id, v.posti_totali FROM public.veicolo v WHERE v.posti_totali >= 3 ORDER BY v.id LIMIT 3`);
  if (candidates.rows.length) result('PASS', `Veicoli con almeno 3 posti: ${candidates.rows.map(x=>x.id).join(', ')}`);
  else result('GAP', 'Nessun veicolo con almeno 3 posti per fixture A+B+C');
  const users = await client.query('SELECT id FROM public.utente ORDER BY id LIMIT 3');
  if (users.rows.length) result('PASS', `Utenti per FK: ${users.rows.map(x=>x.id).join(', ')}`);
  else result('GAP', 'Nessun utente per FK');
} catch (e) {
  result('FAIL', `PostgreSQL: ${e.message}`);
} finally {
  client?.release();
  await pool.end();
}
console.log(`\nRISULTATO: ${pass} PASS / ${fail} FAIL / ${gap} GAP`);
if (fail) process.exitCode = 1;
