import express from 'express';
import Stripe from 'stripe';
import { pool } from '../db/db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

export const router = express.Router();

// -------------------- POST /booking/payment-intent --------------------
router.post('/payment-intent', async (req, res) => {
  try {
    const { type, prezzo, pendingId, corsaId } = req.body;
    if (!prezzo || prezzo <= 0) return res.status(400).json({ error: 'Prezzo non valido' });

    const clienteId = req.user?.id; // optional

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(prezzo * 100),
      currency: 'eur',
      description: type === 'prenota' ? 'Prenotazione TURENTU' : 'Richiesta TURENTU',
      metadata: {
        tipo: type,
        pendingId: pendingId || '',
        corsaId: corsaId || '',
        clienteId: clienteId ? clienteId.toString() : 'guest',
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('❌ Stripe PaymentIntent error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- GET /booking/cliente/prenotazioni --------------------
// Mostra solo le prenotazioni del cliente loggato
router.get('/cliente/prenotazioni', authMiddleware, requireRole('cliente'), async (req, res) => {
  try {
    const clienteId = req.user.id;
    const result = await pool.query(
      'SELECT * FROM prenotazioni WHERE cliente_id = $1 ORDER BY id DESC',
      [clienteId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ GET prenotazioni cliente error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});
