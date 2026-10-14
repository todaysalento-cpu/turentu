// Salva come tests/prepara_popbus_v2_test350.js
// Eseguire UNA volta. Non avvia il worker e non cattura pagamenti.
import 'dotenv/config';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/db.js';

const SOURCE_ID = 31;
const AMOUNT_CENTS = 35000;
// Data futura: verificare che il veicolo sia disponibile in questa fascia.
const START_ISO = '2026-10-16T11:00:00.000Z';
const TEST_TAG = 'popbus-v2-e2e-350-20261014';
let pi = null;
let inserted = false;

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key?.startsWith('sk_test_')) throw new Error('BLOCCATO: Stripe non in modalita test');
  if (new Date(START_ISO).getTime() <= Date.now() + 60 * 60 * 1000) {
    throw new Error('BLOCCATO: START_ISO deve essere almeno un ora nel futuro');
  }
  const stripe = new Stripe(key);
  const { rows: [source] } = await pool.query(`
    SELECT * FROM richieste_pop_bus WHERE id=$1
  `, [SOURCE_ID]);
  if (!source || source.cliente_id !== 101 || source.start_node_id !== 13 ||
      source.end_node_id !== 5 || source.posti_richiesti !== 8 || source.classe !== 'EXPRESS') {
    throw new Error('BLOCCATO: dati modello 31 diversi da quelli verificati');
  }
  const { rows: previous } = await pool.query(`
    SELECT id, payment_intent_id, stato FROM richieste_pop_bus
    WHERE origine_address=$1 AND destinazione_address=$2
      AND prezzo=350 AND classe='EXPRESS' AND start_datetime=$3
      AND cliente_id=$4
  `, [source.origine_address, source.destinazione_address, START_ISO, source.cliente_id]);
  if (previous.length) throw new Error('BLOCCATO: richiesta test gia presente: ' + JSON.stringify(previous));

  const requestId = randomUUID();
  console.log('Creazione autorizzazione Stripe TEST, senza capture...');
  pi = await stripe.paymentIntents.create({
    amount: AMOUNT_CENTS,
    currency: 'eur',
    capture_method: 'manual',
    payment_method: 'pm_card_visa',
    confirm: true,
    payment_method_types: ['card'],
    metadata: { clienteId: String(source.cliente_id), requestId, testTag: TEST_TAG }
  }, { idempotencyKey: `popbus-v2-test350-${requestId}` });
  if (pi.status !== 'requires_capture' || pi.amount_capturable < AMOUNT_CENTS ||
      pi.currency !== 'eur' || pi.capture_method !== 'manual') {
    throw new Error(`BLOCCATO: autorizzazione Stripe non valida: ${pi.status}, capturable=${pi.amount_capturable}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [created] } = await client.query(`
      INSERT INTO richieste_pop_bus (
        cliente_id, origine, destinazione, start_datetime,
        posti_richiesti, stato, corsa_id, start_node_id, end_node_id,
        target_missione_id, classe, direttrice_id,
        origine_address, destinazione_address, prezzo,
        payment_intent_id, request_id, target_direttrice_id
      ) VALUES (
        $1,$2,$3,$4,8,'in_attesa',NULL,13,5,
        NULL,'EXPRESS',NULL,$5,$6,350,$7,$8,NULL
      ) RETURNING id, cliente_id, start_datetime, prezzo, stato, payment_intent_id, request_id
    `, [source.cliente_id, source.origine, source.destinazione, START_ISO,
        source.origine_address, source.destinazione_address, pi.id, requestId]);
    await client.query('COMMIT');
    inserted = true;
    console.log('RICHIESTA CREATA:', created);
    console.log('PROSSIMO PASSO: preparare un test worker filtrato su ID', created.id);
    console.log('NON eseguire il vecchio test che filtra ID 31.');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

try {
  await main();
} catch (e) {
  console.error('PREPARAZIONE FALLITA:', e.message);
  if (pi && !inserted && pi.status === 'requires_capture') {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      await stripe.paymentIntents.cancel(pi.id);
      console.error('Autorizzazione di test annullata:', pi.id);
    } catch (cancelErr) {
      console.error('ATTENZIONE: annullare manualmente il PaymentIntent:', pi.id, cancelErr.message);
    }
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
