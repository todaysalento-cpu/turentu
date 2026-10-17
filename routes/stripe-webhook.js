
import express from 'express';
import Stripe from 'stripe';
import { pool } from '../db/db.js';
import * as pendingService from '../services/pending/pending.service.js';
import { createCorsaFromPending } from '../services/corsa/corsa.service.js';
import { calcolaPrezzo } from '../utils/pricing.util.js';
import { getIO } from '../socket.js';

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('[STRIPE WEBHOOK] STRIPE_SECRET_KEY mancante');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2022-11-15',
});

const router = express.Router();

/**
 * Il webhook deve ricevere il body originale per verificare
 * la firma Stripe. In server.js deve essere montato prima
 * di express.json().
 */
router.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secret) {
      console.error('[STRIPE WEBHOOK] STRIPE_WEBHOOK_SECRET mancante');
      return res.status(500).json({
        error: 'Configurazione webhook mancante',
      });
    }

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error('[STRIPE WEBHOOK] Firma non valida:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const client = await pool.connect();

    try {
      const intent = event.data.object;
      const metadata = intent.metadata || {};

      const tipo = metadata.tipo;
      const pendingId = metadata.pendingId
        ? Number(metadata.pendingId)
        : null;
      const corsaId = metadata.corsaId
        ? Number(metadata.corsaId)
        : null;
      const clienteId = metadata.clienteId
        ? Number(metadata.clienteId)
        : null;

      const roomId = corsaId || pendingId;

      switch (event.type) {
        case 'payment_intent.amount_capturable_updated': {
          await aggiornaStato(
            intent.id,
            'autorizzazione',
            client
          );
          break;
        }

        case 'payment_intent.succeeded': {
          await handlePaymentSuccess({
            intent,
            tipo,
            pendingId,
            corsaId,
            clienteId,
            roomId,
            client,
          });
          break;
        }

        case 'payment_intent.payment_failed': {
          await handlePaymentFailed({
            intent,
            roomId,
            stato: 'fallito',
            client,
          });
          break;
        }

        case 'payment_intent.canceled': {
          await handlePaymentFailed({
            intent,
            roomId,
            stato: 'annullato',
            client,
          });
          break;
        }

        default:
          console.log(
            `[STRIPE WEBHOOK] Evento ignorato: ${event.type}`
          );
      }

      return res.json({ received: true });
    } catch (err) {
      console.error(
        '[STRIPE WEBHOOK] Errore durante la gestione evento:',
        err.message
      );

      return res.status(500).json({
        error: 'Webhook handling error',
      });
    } finally {
      client.release();
    }
  }
);

// =====================================================
// AGGIORNAMENTO STATO PAGAMENTO
// =====================================================

async function aggiornaStato(stripeIntentId, stato, client) {
  const statiConsentiti = [
    'pendente',
    'autorizzazione',
    'pagato',
    'rimborsato',
    'annullato',
    'fallito',
  ];

  if (!statiConsentiti.includes(stato)) {
    throw new Error(`Stato pagamento non consentito: ${stato}`);
  }

  const result = await client.query(
    `UPDATE public.pagamenti
     SET stato = $1,
         updated_at = NOW()
     WHERE stripe_payment_intent = $2
       AND stato NOT IN ('pagato', 'rimborsato')
     RETURNING id`,
    [stato, stripeIntentId]
  );

  if (result.rowCount === 0) {
    const existing = await client.query(
      `SELECT id, stato
       FROM public.pagamenti
       WHERE stripe_payment_intent = $1`,
      [stripeIntentId]
    );

    if (existing.rowCount === 0) {
      console.warn(
        `[STRIPE WEBHOOK] Nessun pagamento DB trovato per ${stripeIntentId}`
      );
    } else {
      console.log(
        `[STRIPE WEBHOOK] Stato non modificato per ${stripeIntentId}:`,
        existing.rows[0].stato
      );
    }
  }
}

// =====================================================
// PAGAMENTO COMPLETATO
// =====================================================

async function handlePaymentSuccess({
  intent,
  tipo,
  pendingId,
  corsaId,
  clienteId,
  roomId,
  client,
}) {
  await aggiornaStato(intent.id, 'pagato', client);

  const io = getIO();

  // Prenotazione già esistente.
  if (tipo === 'prenota' && corsaId) {
    io.to(`prenotazione_cliente_${roomId}`).emit(
      'prenotazione_update',
      {
        status: 'pagato',
        paymentIntentId: intent.id,
        corsaId,
      }
    );

    return;
  }

  // Richiesta che deve generare una corsa dal pending.
  if (tipo === 'richiedi' && pendingId) {
    const pending = await pendingService.getPendingById(
      pendingId,
      client
    );

    if (!pending) {
      throw new Error(`Pending ${pendingId} non trovato`);
    }

    const veicoloRes = await client.query(
      `SELECT *
       FROM public.veicolo
       WHERE id = $1`,
      [pending.veicolo_id]
    );

    const veicolo = veicoloRes.rows[0];

    if (!veicolo) {
      throw new Error('Veicolo non trovato');
    }

    const { corsa, prenotazione } =
      await createCorsaFromPending(
        pending,
        veicolo,
        client
      );

    console.log(
      '[STRIPE WEBHOOK] Corsa creata da pending:',
      corsa.id,
      'Prenotazione:',
      prenotazione?.id
    );

    await pendingService.updatePendingStatus(
      pendingId,
      'processed',
      client
    );

    io.to(`prenotazione_cliente_${roomId}`).emit(
      'prenotazione_update',
      {
        status: 'pagato',
        paymentIntentId: intent.id,
        pendingId,
      }
    );

    return;
  }

  // Cattura delle altre prenotazioni autorizzate
  // associate alla stessa corsa.
  if (corsaId) {
    const { rows: prenotazioni } = await client.query(
      `SELECT
         pr.id AS prenotazione_id,
         pr.posti_prenotati,
         p.id AS pagamento_id,
         p.stripe_payment_intent
       FROM public.prenotazioni pr
       JOIN public.pagamenti p
         ON p.prenotazione_id = pr.id
       WHERE pr.corsa_id = $1
         AND p.stato = 'autorizzazione'
         AND p.stripe_payment_intent IS NOT NULL`,
      [corsaId]
    );

    const { rows: corsaRes } = await client.query(
      `SELECT
         id,
         veicolo_id,
         distanza,
         posti_prenotati,
         primo_posto
       FROM public.corse
       WHERE id = $1`,
      [corsaId]
    );

    if (!corsaRes[0]) {
      throw new Error(`Corsa ${corsaId} non trovata`);
    }

    const corsa = corsaRes[0];

    corsa.distanza = Number.parseFloat(corsa.distanza);

    if (!Number.isFinite(corsa.distanza)) {
      corsa.distanza = 0;
    }

    for (const p of prenotazioni) {
      try {
        // Controlla lo stato reale prima di tentare una cattura.
        const pi = await stripe.paymentIntents.retrieve(
          p.stripe_payment_intent
        );

        if (pi.status !== 'requires_capture') {
          console.warn(
            `[STRIPE CAPTURE] Prenotazione ${p.prenotazione_id}: ` +
            `stato Stripe ${pi.status}; cattura non eseguita.`
          );

          continue;
        }

        const prezzoFinale = await calcolaPrezzo(
          {
            ...corsa,
            distanza: corsa.distanza,
            posti_prenotati: corsa.posti_prenotati,
            primo_posto: corsa.primo_posto,
          },
          p.posti_prenotati,
          'prenotabile'
        );

        const amount = Math.round(prezzoFinale * 100);

        if (
          !Number.isSafeInteger(amount) ||
          amount <= 0 ||
          amount > pi.amount
        ) {
          console.error(
            `[STRIPE CAPTURE] Importo non valido per pagamento ${p.pagamento_id}`,
            {
              amount_calcolato: amount,
              amount_autorizzato: pi.amount,
            }
          );

          continue;
        }

        const captured = await stripe.paymentIntents.capture(
          p.stripe_payment_intent,
          {
            amount_to_capture: amount,
          }
        );

        if (captured.status !== 'succeeded') {
          console.warn(
            `[STRIPE CAPTURE] Pagamento ${p.pagamento_id}: ` +
            `stato dopo cattura ${captured.status}`
          );

          continue;
        }

        await client.query(
          `UPDATE public.pagamenti
           SET stato = 'pagato',
               importo = $1,
               updated_at = NOW()
           WHERE id = $2
             AND stato = 'autorizzazione'`,
          [amount / 100, p.pagamento_id]
        );

        io.to(
          `prenotazione_cliente_${p.prenotazione_id}`
        ).emit('prenotazione_update', {
          status: 'pagato',
          paymentIntentId: p.stripe_payment_intent,
          corsaId,
        });
      } catch (err) {
        console.error(
          `[STRIPE CAPTURE] Errore pagamento ${p.pagamento_id}:`,
          err.message
        );

        // Non impostare automaticamente "pendente":
        // Stripe potrebbe aver completato la cattura
        // anche se la risposta è andata persa.
      }
    }
  }

  // Evita variabili inutilizzate e mantiene disponibili
  // i riferimenti cliente nel flusso webhook.
  void clienteId;
}

// =====================================================
// PAGAMENTO FALLITO O PAYMENT INTENT ANNULLATO
// =====================================================

async function handlePaymentFailed({
  intent,
  roomId,
  stato,
  client,
}) {
  if (!['fallito', 'annullato'].includes(stato)) {
    throw new Error(`Esito pagamento non valido: ${stato}`);
  }

  await aggiornaStato(intent.id, stato, client);

  const io = getIO();

  io.to(`prenotazione_cliente_${roomId}`).emit(
    'prenotazione_update',
    {
      status: stato,
      paymentIntentId: intent.id,
    }
  );

  console.log(
    `[STRIPE WEBHOOK] PaymentIntent ${intent.id}: ${stato}`
  );
}

export { router };
