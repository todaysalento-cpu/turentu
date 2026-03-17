import { pool } from '../../db/db.js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

/**
 * Crea PaymentIntent e registra pagamento
 */
export async function creaPagamentoStripe(prenotazioneId, importo, tipoCorsa, client) {
  let localClient = false;
  if (!client) {
    client = await pool.connect();
    localClient = true;
  }

  try {
    if (localClient) await client.query('BEGIN');

    // Genera PaymentIntent su Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(importo * 100),
      currency: 'eur',
      metadata: { prenotazioneId, tipoCorsa },
    });

    // Registra pagamento nel DB con stripePaymentIntentId
    const res = await client.query(
      `INSERT INTO pagamenti
        (prenotazione_id, importo, currency, stato, tipo_corsa, stripe_payment_intent)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [prenotazioneId, importo, 'eur', 'pendente', tipoCorsa, paymentIntent.id]
    );

    if (localClient) await client.query('COMMIT');

    return { pagamento: res.rows[0], clientSecret: paymentIntent.client_secret };
  } catch (err) {
    if (localClient) await client.query('ROLLBACK');
    console.error('Errore creaPagamentoStripe:', err.message);
    throw err;
  } finally {
    if (localClient) client.release();
  }
}

export default { creaPagamentoStripe };
