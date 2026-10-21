// POPBUS 5F.4-F — Chiusura sicura della fixture: Stripe TEST cancel + cleanup DB.
// Salva come tests/popbus-5f4f-safe-cleanup.js. Default DRY RUN.
// Esecuzione reale SOLO con POPBUS_5F4_CLEANUP=YES e POPBUS_5F4_RENDER_QUIET=YES.
// Non esegue worker, non acquisisce pagamenti, non modifica servizi applicativi.
import 'dotenv/config';
import Stripe from 'stripe';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../db/db.js';

const manifestPath = resolve('tests/popbus-5f4-fixture.json');
const auditPath = resolve('tests/popbus-5f4f-cleanup-audit.json');
const assert = (x, msg) => { if (!x) throw new Error(msg); };
const eq = (a,b) => String(a) === String(b);
let client;
let committed = false;
let stripeCanceled = false;
try {
  const execute = process.env.POPBUS_5F4_CLEANUP === 'YES';
  assert(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 'Chiave Stripe TEST obbligatoria');
  assert(process.env.POPBUS_PIXEL_FIRST_ENABLED === 'false', 'POPBUS_PIXEL_FIRST_ENABLED deve essere false');
  assert(process.env.POPBUS_RECON_WORKER_ENABLED === 'false' && process.env.POPBUS_RECON_ENABLED === 'NO' && process.env.POPBUS_RECON_APPROVED === 'NO', 'Worker locale deve essere disabilitato');
  if (execute) assert(process.env.POPBUS_5F4_RENDER_QUIET === 'YES', 'Confermare Render sospeso con POPBUS_5F4_RENDER_QUIET=YES');
  const m = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(m.test === 'POPBUS_5F4_A' && /^POPBUS_5F4_/.test(m.tag || ''), 'Manifest non riconosciuto');
  assert(m.phase === 'idempotence_verified', 'Fase manifest inattesa');
  assert(eq(m.riservaId,16) && eq(m.corsaId,944) && eq(m.clienteId,291) && eq(m.veicoloId,368), 'ID fixture non corrispondono al collaudo 5F.4');
  assert(/^pi_[A-Za-z0-9]+$/.test(m.paymentIntentId || ''), 'PaymentIntent mancante');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const pi = await stripe.paymentIntents.retrieve(m.paymentIntentId);
  assert(pi.livemode === false && pi.currency === 'eur' && pi.amount === 200 && pi.amount_received === 0 && pi.capture_method === 'manual', 'PaymentIntent non conforme: STOP');
  assert(pi.status === 'canceled' && pi.amount_capturable === 0, 'Stripe deve essere gia canceled, con zero acquisibile: STOP');
  assert(pi.metadata?.test === 'POPBUS_5F4', 'Marker Stripe TEST 5F.4 errato');
  for (const [k,v] of Object.entries({tipo:'popbus_confirmed',riservaId:String(m.riservaId),corsaId:String(m.corsaId),clienteId:String(m.clienteId),requestId:m.requestId})) {
    assert(pi.metadata?.[k] === v, `Metadata Stripe ${k} non coerente`);
  }
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='3s'");
  await client.query("SET LOCAL statement_timeout='15s'");
  const db = await client.query('SELECT current_database() AS name');
  assert(db.rows[0]?.name === 'corse_db', 'Database errato');
  // Lock solo sulle righe fixture; nessun lock globale né worker avviato.
  const rQ = await client.query('SELECT * FROM public.popbus_riserve WHERE id=$1 FOR UPDATE', [m.riservaId]);
  assert(rQ.rowCount === 1, 'Riserva mancante');
  const r = rQ.rows[0];
  assert(eq(r.request_id,m.requestId) && eq(r.corsa_id,m.corsaId) && eq(r.cliente_id,m.clienteId) && r.payment_intent_id === m.paymentIntentId && r.stato === 'scaduta' && r.prenotazione_id === null && Number(r.prezzo) === 2, 'Riserva non conforme');
  const cQ = await client.query('SELECT * FROM public.corse WHERE id=$1 FOR UPDATE', [m.corsaId]);
  assert(cQ.rowCount === 1 && eq(cQ.rows[0].veicolo_id,m.veicoloId) && cQ.rows[0].origine_address?.startsWith(m.tag), 'Corsa non riconosciuta come fixture');
  const vQ = await client.query('SELECT * FROM public.veicolo WHERE id=$1 FOR UPDATE', [m.veicoloId]);
  assert(vQ.rowCount === 1 && vQ.rows[0].modello === m.tag, 'Veicolo non riconosciuto come fixture');
  const uQ = await client.query('SELECT id,nome,email FROM public.utente WHERE id=$1 FOR UPDATE', [m.clienteId]);
  assert(uQ.rowCount === 1 && uQ.rows[0].nome === m.tag && uQ.rows[0].email === `${m.tag.toLowerCase()}@example.invalid`, 'Cliente non riconosciuto come fixture');
  const jQ = await client.query('SELECT * FROM public.popbus_payment_reconciliation WHERE riserva_id=$1 OR payment_intent_id=$2 FOR UPDATE',[m.riservaId,m.paymentIntentId]);
  assert(jQ.rowCount === 1 && eq(jQ.rows[0].riserva_id,m.riservaId) && jQ.rows[0].payment_intent_id === m.paymentIntentId && jQ.rows[0].stato === 'canceled', 'Job inatteso');
  const otherR = await client.query('SELECT id FROM public.popbus_riserve WHERE corsa_id=$1 AND id<>$2 LIMIT 1',[m.corsaId,m.riservaId]);
  assert(otherR.rowCount === 0, 'Altre riserve sulla corsa sintetica: STOP');
  const otherC = await client.query('SELECT id FROM public.corse WHERE veicolo_id=$1 AND id<>$2 LIMIT 1',[m.veicoloId,m.corsaId]);
  assert(otherC.rowCount === 0, 'Altre corse sul veicolo sintetico: STOP');
  const report = {test:'POPBUS_5F4_F',timestamp:new Date().toISOString(),fixture:{clienteId:m.clienteId,veicoloId:m.veicoloId,corsaId:m.corsaId,riservaId:m.riservaId,paymentIntentId:m.paymentIntentId,requestId:m.requestId},stripeBefore:{status:pi.status,livemode:pi.livemode,amountReceived:pi.amount_received},jobBefore:{id:String(jQ.rows[0].id),stato:jQ.rows[0].stato,tentativi:jQ.rows[0].tentativi,ultimo_errore:jQ.rows[0].ultimo_errore},endToEndPassed:true,idempotencePassed:true};
  console.log('[5F.4-F] Precheck PASS', JSON.stringify(report));
  if (!execute) {
    await client.query('ROLLBACK');
    console.log('[5F.4-F] DRY RUN: nessuna modifica. Per procedere: set POPBUS_5F4_CLEANUP=YES');
  } else {
    // Il PI e gia annullato da R3: nessuna operazione di scrittura su Stripe.
    const canceled = pi;
    assert(canceled.status === 'canceled' && canceled.livemode === false && canceled.amount_received === 0 && canceled.amount_capturable === 0, 'Stripe non conferma cancellazione senza incasso; DB non eliminato');
    stripeCanceled = true;
    // Niente cascata volontaria: cancelliamo esplicitamente nell'ordine dei vincoli.
    for (const [sql,args,label] of [
      ['DELETE FROM public.popbus_payment_reconciliation WHERE id=$1 AND riserva_id=$2 AND payment_intent_id=$3 RETURNING id',[jQ.rows[0].id,m.riservaId,m.paymentIntentId],'job'],
      ['DELETE FROM public.popbus_riserve WHERE id=$1 AND request_id=$2 AND payment_intent_id=$3 RETURNING id',[m.riservaId,m.requestId,m.paymentIntentId],'riserva'],
      ['DELETE FROM public.corse WHERE id=$1 AND veicolo_id=$2 RETURNING id',[m.corsaId,m.veicoloId],'corsa'],
      ['DELETE FROM public.veicolo WHERE id=$1 AND modello=$2 RETURNING id',[m.veicoloId,m.tag],'veicolo'],
      ['DELETE FROM public.utente WHERE id=$1 AND nome=$2 RETURNING id',[m.clienteId,m.tag],'cliente']
    ]) {
      const out = await client.query(sql,args);
      assert(out.rowCount === 1, `Cleanup ${label}: attesa una riga, trovate ${out.rowCount}`);
    }
    // Scriviamo audit prima del COMMIT, così un errore filesystem causa ROLLBACK DB.
    report.stripeAfter={status:canceled.status,amountReceived:canceled.amount_received,amountCapturable:canceled.amount_capturable};
    report.dbCleanup='committing';
    await writeFile(auditPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    await client.query('COMMIT');
    committed=true;
    report.dbCleanup='committed';
    const tmp=auditPath+'.tmp';
    await writeFile(tmp,JSON.stringify(report,null,2)+'\n');
    await rename(tmp,auditPath);
    console.log('[POPBUS 5F.4-F] PASS: Stripe TEST canceled, importo incassato 0, fixture DB rimossa.');
    console.log('Audit:',auditPath);
    console.log('End-to-end R2 -> R3 e idempotenza: PASS.');
  }
} catch (e) {
  if (client && !committed) {try {await client.query('ROLLBACK');} catch {}}
  console.error('[POPBUS 5F.4-F] FAIL/ABORT:',e?.stack || e);
  if (stripeCanceled) console.error('Stripe potrebbe essere gia canceled; controllare audit/DB prima di ripetere.');
  process.exitCode=1;
} finally {
  client?.release();
  await pool.end();
}
