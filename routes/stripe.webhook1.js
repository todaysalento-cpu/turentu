import express from 'express';
import { pool } from '../db/db.js';
const router = express.Router();

/**
 * Gestisce l'evento webhook di Stripe
 */
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sigHeader = req.headers['stripe-signature'];
  const event = req.body;

  // Verifica la firma dell'evento (sicurezza)
  const secret = 'your_stripe_webhook_secret'; // Sostituire con il tuo webhook secret

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event, sigHeader, secret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Gestisci diversi tipi di eventi
  switch (stripeEvent.type) {
    case 'payment_intent.succeeded':
      await aggiornaStato(stripeEvent.data.object.id, 'pagato');
      break;
    case 'payment_intent.payment_failed':
      await aggiornaStato(stripeEvent.data.object.id, 'annullato');
      break;
    default:
      console.log(`Evento non gestito: ${stripeEvent.type}`);
  }

  res.json({ received: true });
});

/**
 * Funzione per aggiornare lo stato del pagamento
 */
async function aggiornaStato(stripeIntentId, stato) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      UPDATE pagamenti
      SET stato = $1
      WHERE stripe_payment_intent = $2
      `,
      [stato, stripeIntentId]
    );
  } finally {
    client.release();
  }
}

export { router };
