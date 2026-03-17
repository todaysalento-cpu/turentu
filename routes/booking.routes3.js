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
      const { veicolo_id, start_datetime, durata, durata_minuti, posti_richiesti, origine, destinazione } = slot;

      if (!origine?.lat || !origine?.lon || !destinazione?.lat || !destinazione?.lon) {
        throw new Error("Slot mancante di coordinate valide (origine/destinazione)");
      }
      if (!start_datetime) {
        throw new Error("start_datetime mancante");
      }

      // 🔹 Trasforma la durata in minuti, gestendo anche { seconds: ... }
      let durataMin;
      if (durata_minuti != null) {
        durataMin = Number(durata_minuti);
      } else if (durata != null) {
        if (typeof durata === 'object') {
          if (durata.minutes != null) {
            durataMin = Number(durata.minutes);
          } else if (durata.seconds != null) {
            durataMin = Number(durata.seconds); // ← nuovo fallback
          } else {
            throw new Error("Durata non valida nello slot: " + JSON.stringify(durata));
          }
        } else {
          durataMin = Number(durata);
        }
      } else {
        durataMin = 30; // default
      }

      if (isNaN(durataMin) || durataMin <= 0) {
        throw new Error("Durata non valida nello slot: " + JSON.stringify(slot.durata));
      }

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
          durataMin, // numero corretto in minuti
          posti_richiesti,
          type,
          prezzo / slots.length,
          origine.lon,
          origine.lat,
          destinazione.lon,
          destinazione.lat,
          paymentIntent.id,
          requestId,
          expiresAt,
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

export default router;
