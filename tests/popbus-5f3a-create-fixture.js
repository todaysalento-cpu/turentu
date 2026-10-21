// POPBUS 5F.3-A — crea esclusivamente fixture sintetiche; NON chiama Stripe e NON esegue R3.
// Salva come tests/popbus-5f3a-create-fixture.js (Node ESM).
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../db/db.js';

const requireValue = (name, expected) => {
  if (process.env[name] !== expected) throw new Error(`${name} deve essere ${expected}`);
};
const fixtureTag = `POPBUS_5F3_${randomUUID()}`;
const requestId = randomUUID();
const email = `${fixtureTag.toLowerCase()}@example.invalid`;
const manifestPath = resolve('tests', 'popbus-5f3-fixture.json');
let client;
let committed = false;
try {
  requireValue('POPBUS_5F3_CREATE', 'YES');
  requireValue('POPBUS_PIXEL_FIRST_ENABLED', 'false');
  requireValue('POPBUS_RECON_WORKER_ENABLED', 'false');
  requireValue('POPBUS_RECON_ENABLED', 'NO');
  requireValue('POPBUS_RECON_APPROVED', 'NO');
  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new Error('Stripe TEST obbligatorio');
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '15s'");
  const identity = await client.query('SELECT current_database() AS db');
  if (identity.rows[0]?.db !== 'corse_db') throw new Error('Database inatteso');
  const existing = await client.query(`
    SELECT r.id FROM public.popbus_riserve r
    LEFT JOIN public.popbus_payment_reconciliation j ON j.riserva_id=r.id
    WHERE r.payment_intent_id IS NOT NULL AND r.prenotazione_id IS NULL
      AND (r.stato IN ('scaduta','annullata') OR (r.stato='riservata' AND r.expires_at <= NOW()))
      AND (j.id IS NULL OR j.stato IN ('pending','retry','processing'))
      AND (j.id IS NULL OR j.stato <> 'retry' OR j.prossimo_tentativo_at IS NULL OR j.prossimo_tentativo_at <= NOW())
      AND (j.id IS NULL OR j.stato <> 'processing' OR j.claimed_at < NOW() - INTERVAL '5 minutes')
    LIMIT 1`);
  if (existing.rowCount) throw new Error('ABORT: esistono riserve eleggibili estranee alla fixture');
  const u = await client.query(`INSERT INTO public.utente (nome,email,tipo,password)
    VALUES ($1,$2,'cliente',$3) RETURNING id`, [fixtureTag, email, `TEST_DISABLED_${randomUUID()}`]);
  const v = await client.query(`INSERT INTO public.veicolo (modello,posti_totali,servizi,marca)
    VALUES ($1,4,'[]'::jsonb,'TEST') RETURNING id`, [fixtureTag]);
  const c = await client.query(`INSERT INTO public.corse
    (veicolo_id,start_datetime,tipo_corsa,stato,posti_totali,posti_disponibili,origine_address,destinazione_address)
    VALUES ($1,NOW() + INTERVAL '2 days','condivisa','prenotabile',4,4,$2,$3) RETURNING id`, [v.rows[0].id, fixtureTag + '_ORIGINE', fixtureTag + '_DESTINAZIONE']);
  const r = await client.query(`INSERT INTO public.popbus_riserve
    (request_id,corsa_id,cliente_id,posti_richiesti,start_offset,end_offset,start_index_polyline,end_index_polyline,prezzo,expires_at,stato)
    VALUES ($1,$2,$3,1,0,10,0,1,2.00,NOW() + INTERVAL '15 minutes','riservata') RETURNING id`,
    [requestId, c.rows[0].id, u.rows[0].id]);
  const manifest = {
    test: 'POPBUS_5F3_A', tag: fixtureTag, requestId,
    clienteId: u.rows[0].id, veicoloId: v.rows[0].id,
    corsaId: c.rows[0].id, riservaId: r.rows[0].id,
    paymentIntentId: null, phase: 'fixture_created_no_stripe',
    createdAt: new Date().toISOString()
  };
  // Il manifest deve essere scritto prima del COMMIT: senza manifest non persistiamo la fixture.
  // File esclusivo: non sovrascrive una fixture precedente.
  await mkdir(resolve('tests'), {recursive:true});
  await writeFile(manifestPath, JSON.stringify(manifest,null,2)+'\n', {flag:'wx'});
  await client.query('COMMIT');
  committed = true;
  console.log('[POPBUS 5F.3-A] PASS: fixture creata; nessun PaymentIntent associato');
  console.table([{clienteId:manifest.clienteId,veicoloId:manifest.veicoloId,corsaId:manifest.corsaId,riservaId:manifest.riservaId}]);
  console.log('Manifest:',manifestPath);
  console.log('Non avviare ancora il worker: la fixture NON e ancora eleggibile al batch R3.');
} catch (err) {
  if (client && !committed) { try { await client.query('ROLLBACK'); } catch {} }
  console.error('[POPBUS 5F.3-A] ABORT:',err.message);
  console.error('Se esiste tests/popbus-5f3-fixture.json dopo un errore, conservarlo e verificare gli ID prima di ritentare.');
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
