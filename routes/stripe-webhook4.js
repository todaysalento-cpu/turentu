// ======================= stripe-webhook.js =======================
import express from 'express';
import Stripe from 'stripe';
import { pool } from '../db/db.js';
import { io } from '../server.js';
import * as pendingService from '../services/pending/pending.service.js';
import { createCorsaFromPending } from '../services/corsa/corsa.service.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });
const router = express.Router();

/**
 * ⚠️ Questo webhook DEVE essere montato:
 * app.use('/webhook-stripe', router);
 * PRIMA di express.json()
 */
router.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error('❌ Stripe signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const client = await pool.connect();

    try {
      const intent = event.data.object;
      const metadata = intent.metadata || {};
      const tipo = metadata.tipo;
      const pendingId = metadata.pendingId ? Number(metadata.pendingId) : null;
      const corsaId = metadata.corsaId ? Number(metadata.corsaId) : null;
      const clienteId = metadata.clienteId ? Number(metadata.clienteId) : null;

      const roomId = corsaId || pendingId;

      switch (event.type) {

        // 🔒 Autorizzazione creata o aggiornata
        case 'payment_intent.amount_capturable_updated':
          await aggiornaStato(intent.id, 'autorizzazione', client);
          break;

        // 💰 Pagamento catturato / riuscito
        case 'payment_intent.succeeded':
          await handlePaymentSuccess({ intent, tipo, pendingId, corsaId, clienteId, roomId, client });
          break;

        // ❌ Pagamento fallito / annullato
        case 'payment_intent.payment_failed':
        case 'payment_intent.canceled':
          await handlePaymentFailed({ intent, roomId, client });
          break;

        default:
          console.log(`ℹ️ Evento Stripe ignorato: ${event.type}`);
      }

      res.json({ received: true });

    } catch (err) {
      console.error('❌ Errore webhook Stripe:', err);
      res.status(500).json({ error: 'Webhook handling error' });
    } finally {
      client.release();
    }
  }
);

// ===================== FUNZIONI DI SUPPORTO =====================

async function aggiornaStato(stripeIntentId, stato, client) {
  await client.query(
    `UPDATE pagamenti
     SET stato = $1, updated_at = NOW()
     WHERE stripe_payment_intent = $2`,
    [stato, stripeIntentId]
  );
}

/**
 * Gestione successo pagamento
 * - Prenotazioni già esistenti: conferma
 * - Richieste: crea corsa da pending
 * - Corse condivise: cattura ogni prenotazione
 */
async function handlePaymentSuccess({ intent, tipo, pendingId, corsaId, clienteId, roomId, client }) {
  await aggiornaStato(intent.id, 'pagato', client);

  // 🔹 Prenotazione già esistente
  if (tipo === 'prenota' && corsaId) {
    io.to(`prenotazione_cliente_${roomId}`).emit('prenotazione_update', {
      status: 'pagato',
      paymentIntentId: intent.id,
      corsaId,
    });
    return;
  }

  // 🔹 Richiesta → crea corsa dalla pending
  if (tipo === 'richiedi' && pendingId) {
    const pending = await pendingService.getPendingById(pendingId, client);
    if (!pending) throw new Error(`Pending ${pendingId} non trovato`);

    const veicoloRes = await client.query(`SELECT * FROM veicolo WHERE id = $1`, [pending.veicolo_id]);
    const veicolo = veicoloRes.rows[0];
    if (!veicolo) throw new Error('Veicolo non trovato');

    await createCorsaFromPending(pending, veicolo, client);
    await pendingService.updatePendingStatus(pendingId, 'processed', client);

    io.to(`prenotazione_cliente_${roomId}`).emit('prenotazione_update', {
      status: 'pagato',
      paymentIntentId: intent.id,
      pendingId,
    });
    return;
  }

  // 🔹 Corsa condivisa → cattura tutte le prenotazioni con pagamenti in "autorizzazione"
  if (corsaId) {
    const { rows: prenotazioni } = await client.query(
      `SELECT pr.id AS prenotazione_id, pr.posti_prenotati, p.id AS pagamento_id, p.stripe_payment_intent, p.importo
       FROM prenotazioni pr
       JOIN pagamenti p ON p.prenotazione_id = pr.id
       WHERE pr.corsa_id=$1 AND p.stato='autorizzazione'`,
      [corsaId]
    );

    for (const p of prenotazioni) {
      try {
        const amount = Math.round(Number(p.importo) * 100);

        await stripe.paymentIntents.capture(p.stripe_payment_intent, { amount_to_capture: amount });

        await client.query(
          `UPDATE pagamenti
           SET stato='pagato', importo=$1, updated_at=NOW()
           WHERE id=$2`,
          [p.importo, p.pagamento_id]
        );

        io.to(`prenotazione_cliente_${p.prenotazione_id}`).emit('prenotazione_update', {
          status: 'pagato',
          paymentIntentId: p.stripe_payment_intent,
          corsaId,
        });
      } catch (err) {
        console.error(`Errore cattura prenotazione ${p.prenotazione_id}:`, err.message);
      }
    }
  }
}

async function handlePaymentFailed({ intent, roomId, client }) {
  await aggiornaStato(intent.id, 'annullato', client);

  io.to(`prenotazione_cliente_${roomId}`).emit('prenotazione_update', {
    status: 'annullato',
    paymentIntentId: intent.id,
  });
}

export { router };