
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../db/db.js';

const MODE = process.argv[2];
const IDS = [562, 563, 564, 565, 566, 567];
const CLIENTS = [2, 3, 4, 5, 6, 8];
const PRICES = [700, 900, 1400, 700, 900, 1400];

const LOG = path.resolve('tests/pixel322-stripe-test-state.json');
const key = process.env.STRIPE_SECRET_KEY || '';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function save(state) {
  const tmp = LOG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), {
    mode: 0o600
  });
  fs.renameSync(tmp, LOG);
}

function load() {
  check(fs.existsSync(LOG), 'Registro di recupero assente');
  return JSON.parse(fs.readFileSync(LOG, 'utf8'));
}

async function verifyRows() {
  const { rows } = await pool.query(
    `SELECT id, cliente_id, prezzo, stato,
            request_id, payment_intent_id, corsa_id
     FROM public.richieste_pop_bus
     WHERE id = ANY($1::int[])
     ORDER BY id`,
    [IDS]
  );

  check(rows.length === 6, 'Numero richieste inatteso');

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    check(Number(r.id) === IDS[i], 'ID richiesta inatteso');
    check(Number(r.cliente_id) === CLIENTS[i], 'Cliente modificato');
    check(Math.round(Number(r.prezzo) * 100) === PRICES[i],
      'Prezzo modificato');
    check(r.stato === 'in_attesa', 'Stato richiesta modificato');
    check(r.corsa_id === null, 'Richiesta già associata a corsa');
  }

  return rows;
}

async function verifyIntent(stripe, item) {
  const pi = await stripe.paymentIntents.retrieve(item.paymentIntentId);

  check(pi.livemode === false, 'PaymentIntent LIVE');
  check(pi.status === 'requires_capture', 'Autorizzazione non valida');
  check(pi.capture_method === 'manual', 'Capture non manuale');
  check(pi.currency === 'eur', 'Valuta inattesa');
  check(pi.amount === item.amount, 'Importo non corrispondente');
  check(pi.amount_capturable >= item.amount,
    'Importo autorizzato insufficiente');
  check(pi.metadata?.clienteId === String(item.clienteId),
    'Cliente Stripe non corrispondente');
  check(pi.metadata?.requestId === item.requestId,
    'RequestId Stripe non corrispondente');
  check(pi.metadata?.testMarker === 'PIXEL322_SHADOW',
    'PaymentIntent non appartenente al test');

  return pi;
}

async function main() {
  check(['prepare', 'attach', 'cleanup'].includes(MODE),
    'Modalità: prepare | attach | cleanup');

  check(key.startsWith('sk_test_'), 'STOP: chiave Stripe non TEST');

  check(process.env.POPBUS_PIXEL_FIRST !== '1',
    'STOP: PIXEL_FIRST attivo');
  check(process.env.POPBUS_PIXEL_FIRST_ENABLED !== 'true',
    'STOP: PIXEL_FIRST_ENABLED attivo');
  check(process.env.POPBUS_PIXEL_FIRST_LIVE_APPROVED !== '1',
    'STOP: LIVE approvato');

  const stripe = new Stripe(key);
  const rows = await verifyRows();

  if (MODE === 'prepare') {
      if (fs.existsSync(LOG)) {
      console.log('Registro esistente: ripresa controllata');
    }

    for (const r of rows) {
      check(r.request_id === null && r.payment_intent_id === null,
        'Richiesta già collegata');
    }

const state = fs.existsSync(LOG)
  ? load()
  : {
      test: 'PIXEL322_SHADOW',
      createdAt: new Date().toISOString(),
      attached: false,
      items: rows.map((r, i) => ({
        id: Number(r.id),
        clienteId: Number(r.cliente_id),
        amount: PRICES[i],
        requestId: randomUUID(),
        paymentIntentId: null,
        status: 'pending'
      }))
    };

check(state.test === 'PIXEL322_SHADOW',
  'Registro non valido');

check(state.items.length === 6,
  'Numero richieste nel registro non valido');

for (let i = 0; i < 6; i++) {
  const item = state.items[i];

  check(item.id === IDS[i], 'ID nel registro non valido');
  check(item.clienteId === CLIENTS[i],
    'Cliente nel registro non valido');
  check(item.amount === PRICES[i],
    'Importo nel registro non valido');
  check(typeof item.requestId === 'string',
    'UUID nel registro assente');
}

save(state);

       for (const item of state.items) {
      if (item.status === 'prepared') {
        await verifyIntent(stripe, item);
        continue;
      }

      if (item.paymentIntentId) {
        // PaymentIntent già registrato: recuperalo, non ricrearlo.
        await verifyIntent(stripe, item);

        item.status = 'prepared';
        save(state);

        console.log(`RECOVERED richiesta ${item.id}`);
        continue;
      }

      // Se la richiesta Stripe precedente è stata interrotta,
      // non possiamo sapere con certezza se abbia creato il PI.
      // Fermiamoci anziché rischiare un duplicato.
      if (item.status === 'creating') {
        throw new Error(
          `Richiesta ${item.id}: creazione Stripe incerta. ` +
          'Riconciliazione manuale necessaria.'
        );
      }

      check(item.status === 'pending',
        `Stato inatteso richiesta ${item.id}: ${item.status}`);

      item.status = 'creating';
      save(state);

      const idempotencyKey =
        `pixel322-shadow-${item.id}-${item.requestId}`;

      const pi = await stripe.paymentIntents.create({
        amount: item.amount,
        currency: 'eur',
        capture_method: 'manual',
        payment_method_types: ['card'],
        payment_method: 'pm_card_visa',
        confirm: true,
        metadata: {
          tipo: 'popbus',
          clienteId: String(item.clienteId),
          requestId: item.requestId,
          testMarker: 'PIXEL322_SHADOW'
        }
      }, { idempotencyKey });

      item.paymentIntentId = pi.id;
      item.status = 'created';
      save(state);

      await verifyIntent(stripe, item);

      item.status = 'prepared';
      save(state);

      console.log(`PREPARED richiesta ${item.id}`);
    }

    console.log('PREPARE OK: sei autorizzazioni Stripe TEST');
    console.log('Nessuna richiesta database modificata');
    return;
  }

  const state = load();

  check(state.test === 'PIXEL322_SHADOW',
    'Registro non appartenente al collaudo');
  check(state.items.length === 6, 'Registro incompleto');

  if (MODE === 'attach') {
    check(state.items.every(x => x.status === 'prepared'),
      'Autorizzazioni non tutte preparate');

    for (const item of state.items) {
      await verifyIntent(stripe, item);
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const item of state.items) {
        const result = await client.query(
          `UPDATE public.richieste_pop_bus
           SET request_id = $1::uuid,
               payment_intent_id = $2
           WHERE id = $3
             AND cliente_id = $4
             AND stato = 'in_attesa'
             AND corsa_id IS NULL
             AND request_id IS NULL
             AND payment_intent_id IS NULL
             AND ROUND(prezzo * 100) = $5`,
          [
            item.requestId,
            item.paymentIntentId,
            item.id,
            item.clienteId,
            item.amount
          ]
        );

        check(result.rowCount === 1,
          `Collegamento fallito richiesta ${item.id}`);
      }

      await client.query('COMMIT');
      state.attached = true;
      save(state);

      console.log('ATTACH OK: sei richieste collegate');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return;
  }

  if (MODE === 'cleanup') {
    // Prima scollega i riferimenti esatti, senza toccare altre richieste.
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const item of state.items) {
        if (!item.paymentIntentId) continue;

        const result = await client.query(
          `UPDATE public.richieste_pop_bus
           SET request_id = NULL,
               payment_intent_id = NULL
           WHERE id = $1
             AND cliente_id = $2
             AND stato = 'in_attesa'
             AND corsa_id IS NULL
             AND request_id = $3::uuid
             AND payment_intent_id = $4`,
          [
            item.id,
            item.clienteId,
            item.requestId,
            item.paymentIntentId
          ]
        );

        // Zero righe è ammesso soltanto se non era stato collegato.
        if (result.rowCount === 0) {
          const { rows: current } = await client.query(
            `SELECT request_id, payment_intent_id
             FROM public.richieste_pop_bus WHERE id = $1`,
            [item.id]
          );

          check(current.length === 1 &&
            current[0].request_id === null &&
            current[0].payment_intent_id === null,
            `Richiesta ${item.id} modificata: cleanup interrotto`);
        }
      }

      await client.query('COMMIT');
      state.attached = false;
      save(state);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Poi annulla le autorizzazioni TEST.
    for (const item of state.items) {
      if (!item.paymentIntentId || item.status === 'cancelled') continue;

      const pi = await stripe.paymentIntents.retrieve(
        item.paymentIntentId
      );

      check(pi.livemode === false, 'Pagamento LIVE: STOP');
      check(pi.metadata?.testMarker === 'PIXEL322_SHADOW',
        'PaymentIntent estraneo al collaudo');

      if (pi.status === 'requires_capture' ||
          pi.status === 'requires_confirmation' ||
          pi.status === 'requires_payment_method' ||
          pi.status === 'requires_action') {
        await stripe.paymentIntents.cancel(pi.id);
      } else {
        check(pi.status === 'canceled',
          `PaymentIntent ${pi.id} non annullabile: ${pi.status}`);
      }

      item.status = 'cancelled';
      save(state);
      console.log(`CANCELLED richiesta ${item.id}`);
    }

    console.log('CLEANUP OK: riferimenti rimossi e PI annullati');
    console.log('Conserva il registro per audit');
  }
}

main()
  .catch(e => {
    console.error('STOP:', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
