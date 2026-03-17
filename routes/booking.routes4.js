import express from 'express';
import Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';
import { io } from '../server.js'; // ⚡ Socket.IO

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

// -------------------- POST /booking/payment-intent --------------------
router.post('/payment-intent', authMiddleware, async (req, res) => {
  try {
    const { type, prezzo, slots, corsaId } = req.body;

    if (!prezzo || prezzo <= 0) return res.status(400).json({ error: 'Prezzo non valido' });
    if (!type || !['prenota', 'richiedi'].includes(type)) return res.status(400).json({ error: 'Tipo pagamento non valido' });
    if (!slots || !Array.isArray(slots) || slots.length === 0) return res.status(400).json({ error: 'Slots mancanti' });

    const clienteId = req.user.id;
    const requestId = uuidv4();

    // 🔹 Crea PaymentIntent Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(prezzo * 100),
      currency: 'eur',
      description: type === 'prenota' ? 'Prenotazione TURENTU' : 'Richiesta TURENTU',
      metadata: { tipo: type, corsaId: corsaId ?? '', clienteId: clienteId.toString(), requestId },
      capture_method: 'manual',
    });

    const pendingRows = [];

    for (const slot of slots) {
      const { veicolo_id, start_datetime, durata, durata_minuti, posti_richiesti, origine, destinazione } = slot;

      if (!origine?.lat || !origine?.lon || !destinazione?.lat || !destinazione?.lon) {
        throw new Error("Slot mancante di coordinate valide (origine/destinazione)");
      }
      if (!start_datetime) throw new Error("start_datetime mancante");

      // Trasforma durata in minuti
      let durataMin = durata_minuti ?? (typeof durata === 'number' ? durata : 30);
      if (typeof durata === 'object') {
        if (durata.minutes != null) durataMin = durata.minutes;
        else if (durata.seconds != null) durataMin = durata.seconds;
      }
      if (isNaN(durataMin) || durataMin <= 0) throw new Error("Durata non valida nello slot");

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minuti

      const result = await pool.query(
        `INSERT INTO pending
          (veicolo_id, cliente_id, start_datetime, durata, posti_richiesti, tipo_corsa, prezzo, 
           origine, destinazione, stato, payment_intent_id, request_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
                 ST_SetSRID(ST_MakePoint($8, $9), 4326),
                 ST_SetSRID(ST_MakePoint($10, $11), 4326),
                 'pending', $12, $13::uuid, $14)
         RETURNING *,
           ST_X(origine::geometry) AS origine_lon,
           ST_Y(origine::geometry) AS origine_lat,
           ST_X(destinazione::geometry) AS destinazione_lon,
           ST_Y(destinazione::geometry) AS destinazione_lat`,
        [
          veicolo_id,
          clienteId,
          start_datetime,
          durataMin,
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

      const pendingRow = result.rows[0];

      // 🔹 Normalizza prezzo e coord
      pendingRow.prezzo = Number(pendingRow.prezzo);
      const origineCoord = { lat: pendingRow.origine_lat, lon: pendingRow.origine_lon };
      const destinazioneCoord = { lat: pendingRow.destinazione_lat, lon: pendingRow.destinazione_lon };

      pendingRows.push({ ...pendingRow, origine: origineCoord, destinazione: destinazioneCoord });

      // 🔹 Event Socket al driver
      const veicoloRes = await pool.query('SELECT driver_id FROM veicolo WHERE id=$1', [veicolo_id]);
      const driverId = veicoloRes.rows[0]?.driver_id;
      if (driverId) {
        io.to(`autista_${driverId}`).emit('pending_update', {
          id: pendingRow.id,
          cliente: req.user.nome,
          origine: origineCoord,
          destinazione: destinazioneCoord,
          prezzo: pendingRow.prezzo,
          stato: pendingRow.stato,
        });
      }
    }

    // 🔹 Risposta al client
    res.json({
      clientSecret: paymentIntent.client_secret,
      pending: pendingRows.map(p => ({ ...p, prezzo: Number(p.prezzo) })),
      requestId,
    });

  } catch (err) {
    console.error('❌ Stripe PaymentIntent error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
