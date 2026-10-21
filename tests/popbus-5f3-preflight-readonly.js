import 'dotenv/config';
import { pool } from '../db/db.js';

const tag = '[POPBUS 5F.3]';
const tables = ['utente', 'veicolo', 'corse', 'popbus_riserve', 'popbus_payment_reconciliation'];

async function main() {
  console.log(`${tag} PREFLIGHT SOLA LETTURA — nessuna fixture creata, nessuna chiamata Stripe`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const identity = await client.query(`SELECT current_database() AS database, current_user AS db_user,
      current_schema() AS schema, inet_server_addr()::text AS server_ip`);
    console.table(identity.rows);

    const checks = {
      stripeTest: (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_'),
      schedulerOff: process.env.POPBUS_RECON_WORKER_ENABLED !== 'YES',
      pixelFirstOff: process.env.POPBUS_PIXEL_FIRST_ENABLED === 'false',
    };
    console.table(Object.entries(checks).map(([check, pass]) => ({check, pass})));
    if (!checks.stripeTest) throw new Error('Stripe TEST non configurato: interrompo');
    if (!checks.schedulerOff) throw new Error('Scheduler riconciliazione abilitato: interrompo');
    if (!checks.pixelFirstOff) {
      console.warn(`${tag} ATTENZIONE: POPBUS_PIXEL_FIRST_ENABLED non e impostato a false in questo processo. Verificare separatamente i worker Render.`);
    }

    const eligible = await client.query(`
      SELECT r.id::text AS riserva_id, r.stato, r.expires_at,
             j.stato AS job_stato
      FROM public.popbus_riserve r
      LEFT JOIN public.popbus_payment_reconciliation j ON j.riserva_id = r.id
      WHERE r.payment_intent_id IS NOT NULL AND r.prenotazione_id IS NULL
        AND (r.stato IN ('scaduta','annullata') OR (r.stato='riservata' AND r.expires_at <= NOW()))
        AND (j.id IS NULL OR j.stato IN ('pending','retry','processing'))
        AND (j.id IS NULL OR j.stato <> 'retry' OR j.prossimo_tentativo_at IS NULL OR j.prossimo_tentativo_at <= NOW())
        AND (j.id IS NULL OR j.stato <> 'processing' OR j.claimed_at < NOW() - INTERVAL '5 minutes')
      ORDER BY r.expires_at ASC LIMIT 21`);
    console.log(`${tag} Riserve eleggibili (max 21): ${eligible.rowCount}`);
    console.table(eligible.rows);

    const columns = await client.query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`, [tables]);
    console.log(`${tag} Schema tabelle coinvolte:`);
    console.table(columns.rows);

    const constraints = await client.query(`
      SELECT c.conrelid::regclass::text AS tabella, c.conname AS nome,
             pg_get_constraintdef(c.oid) AS definizione
      FROM pg_constraint c
      WHERE c.conrelid = ANY($1::regclass[])
      ORDER BY 1,2`, [tables.map(x => `public.${x}`)]);
    console.log(`${tag} Vincoli:`);
    console.table(constraints.rows);

    await client.query('COMMIT');
    if (eligible.rowCount !== 0) {
      console.error(`${tag} STOP: sono presenti riserve eleggibili non attribuite a una fixture del test.`);
      process.exitCode = 2;
    } else {
      console.log(`${tag} PASS PREFLIGHT: nessuna riserva eleggibile; schema acquisito. Nessuna scrittura.`);
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(`${tag} STOP: ${e.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}
try { await main(); } finally { await pool.end(); }
