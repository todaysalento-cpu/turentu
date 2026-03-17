// ======================= routes/booking.routes.js =======================
import express from 'express';
import Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

// -------------------- POST /booking/payment-intent --------------------
router.post('/payment-intent', authMiddleware, async (req, res) => {
  try {
    const { type, prezzo, slots, corsaId } = req.body;

    if (!prezzo || prezzo <= 0)
      return res.status(400).json({ error: 'Prezzo non valido' });
    if (!type || !['prenota', 'richiedi'].includes(type))
      return res.status(400).json({ error: 'Tipo pagamento non valido' });
    if (!slots || !Array.isArray(slots) || slots.length === 0)
      return res.status(400).json({ error: 'Slots mancanti' });

    const clienteId = req.user.id;
    const requestId = uuidv4(); // UUID univoco per la richiesta

    // Crea PaymentIntent su Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(prezzo * 100), // centesimi
      currency: 'eur',
      description: type === 'prenota' ? 'Prenotazione TURENTU' : 'Richiesta TURENTU',
      metadata: {
        tipo: type,
        corsaId: corsaId ?? '',
        clienteId: clienteId.toString(),
        requestId,
      },
      capture_method: 'manual',
    });

    // Inserisci pending nel DB con geometrie corrette e expires_at a 30 minuti
    const pendingRows = [];
    for (const slot of slots) {
      const { veicolo_id, start_datetime, durata, posti_richiesti, origine, destinazione } = slot;

      if (!origine?.lat || !origine?.lon || !destinazione?.lat || !destinazione?.lon) {
        throw new Error("Slot mancante di coordinate valide (origine/destinazione)");
      }
      if (!start_datetime) {
        throw new Error("start_datetime mancante");
      }

      // 👇 Scadenza a 30 minuti dalla creazione
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minuti

      const result = await pool.query(
        `INSERT INTO pending
          (veicolo_id, cliente_id, start_datetime, durata, posti_richiesti, tipo_corsa, prezzo, 
           origine, destinazione, stato, payment_intent_id, request_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
                 ST_SetSRID(ST_MakePoint($8, $9), 4326),
                 ST_SetSRID(ST_MakePoint($10, $11), 4326),
                 'pending', $12, $13::uuid, $14)
         RETURNING *`,
        [
          veicolo_id,
          clienteId,
          start_datetime,
          durata,
          posti_richiesti,
          type,
          prezzo / slots.length,
          origine.lon,
          origine.lat,
          destinazione.lon,
          destinazione.lat,
          paymentIntent.id,
          requestId, // UUID generato con uuidv4()
          expiresAt, // 30 minuti
        ]
      );

      pendingRows.push(result.rows[0]);
    }

    res.json({
      clientSecret: paymentIntent.client_secret,
      pending: pendingRows,
      requestId,
    });

  } catch (err) {
    console.error('❌ Stripe PaymentIntent error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- POST /booking/capture-payment --------------------
router.post('/capture-payment', authMiddleware, async (req, res) => {
  try {
    const { paymentIntentId, corsaId } = req.body;

    if (!paymentIntentId) return res.status(400).json({ error: 'PaymentIntent mancante' });
    if (!corsaId) return res.status(400).json({ error: 'Corsa mancante' });

    const corsaRes = await pool.query(
      'SELECT distanza, totale_passeggeri FROM corsa WHERE id = $1',
      [corsaId]
    );
    const corsa = corsaRes.rows[0];
    if (!corsa) return res.status(404).json({ error: 'Corsa non trovata' });

    const prezzoKm = 1.0; // esempio, da tariffario
    const prezzoFinale = Math.round((corsa.distanza * prezzoKm * corsa.totale_passeggeri) * 100);

    const paymentIntent = await stripe.paymentIntents.capture(paymentIntentId, {
      amount_to_capture: prezzoFinale
    });

    res.json({
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: (paymentIntent.amount_to_capture / 100).toFixed(2) + '€'
    });

  } catch (err) {
    console.error('❌ Stripe Capture error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
