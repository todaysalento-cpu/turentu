import express from 'express';
import Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';
import { sendNotification, getIO } from '../socket.js'; // ✅ nuovo import

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

// -------------------- Helpers --------------------
function generatePendingMessage({ role, startAddress, endAddress, startDatetime }) {
  const formatStart = (input) => {
    if (!input) return '';
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return '';

    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);

    const isToday = d.toDateString() === today.toDateString();
    const isTomorrow = d.toDateString() === tomorrow.toDateString();

    const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const dayName = d.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'long' });

    if (isToday) return `oggi alle ${time}`;
    if (isTomorrow) return `domani alle ${time}`;
    return `${dayName} alle ${time}`;
  };

  const timeStr = formatStart(startDatetime);

  if (role === 'autista') return `Nuova Richiesta - ${startAddress} → ${endAddress}${timeStr ? ' - ' + timeStr : ''}`;
  if (role === 'cliente') return `Hai richiesto una nuova prenotazione 🏁 ${startAddress} → ${endAddress}${timeStr ? ' - ' + timeStr : ''}`;
  return `Nuova corsa${timeStr ? ' - ' + timeStr : ''}`;
}

function formatNotificationDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';

  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);

  const isToday = d.toDateString() === today.toDateString();
  const isTomorrow = d.toDateString() === tomorrow.toDateString();

  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayName = d.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'long' });

  if (isToday) return `oggi alle ${time}`;
  if (isTomorrow) return `domani alle ${time}`;
  return `${dayName} all’${time}`;
}

// -------------------- POST /booking/payment-intent --------------------
router.post('/payment-intent', authMiddleware, async (req, res) => {
  try {
    const { type, prezzo, slots } = req.body;

    if (!prezzo || prezzo <= 0) return res.status(400).json({ error: 'Prezzo non valido' });
    if (!type || !['prenota', 'richiedi'].includes(type)) return res.status(400).json({ error: 'Tipo pagamento non valido' });
    if (!slots || !Array.isArray(slots) || slots.length === 0) return res.status(400).json({ error: 'Slots mancanti' });

    const clienteId = req.user.id;
    const requestId = uuidv4();

    // 🔹 Crea PaymentIntent su Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(prezzo * 100),
      currency: 'eur',
      description: type === 'prenota' ? 'Prenotazione TURENTU' : 'Richiesta TURENTU',
      metadata: { tipo: type, clienteId: clienteId.toString(), requestId },
      capture_method: 'manual',
    });

    const pendingRows = [];

    for (const slot of slots) {
      let { veicolo_id, start_datetime, posti_richiesti, origine, destinazione, localitaOrigine, localitaDestinazione, distanzaKm } = slot;

      let durataMinuti = slot.durataMinuti ?? slot.durata_minuti;
      if (!durataMinuti || durataMinuti <= 0) throw new Error("Durata dello slot mancante o non valida");
      if (durataMinuti > 5000) durataMinuti = Math.round(durataMinuti / 60);
      if (!origine?.lat || !origine?.lon || !destinazione?.lat || !destinazione?.lon) throw new Error("Coordinate mancanti");
      if (!localitaOrigine || !localitaDestinazione) throw new Error("Indirizzi mancanti");
      if (!start_datetime) throw new Error("start_datetime mancante");

      const durataInterval = `${durataMinuti} minutes`;
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

      const result = await pool.query(
        `INSERT INTO pending
          (veicolo_id, cliente_id, start_datetime, durata, posti_richiesti,
           tipo_corsa, prezzo, distanza,
           origine, destinazione,
           origine_address, destinazione_address,
           stato, payment_intent_id, request_id, expires_at)
         VALUES ($1,$2,$3,$4::interval,$5,$6,$7,$8,
                 ST_SetSRID(ST_MakePoint($9,$10),4326),
                 ST_SetSRID(ST_MakePoint($11,$12),4326),
                 $13,$14,
                 'pending',$15,$16::uuid,$17)
         RETURNING *,
           ST_X(origine::geometry) AS origine_lon,
           ST_Y(origine::geometry) AS origine_lat,
           ST_X(destinazione::geometry) AS destinazione_lon,
           ST_Y(destinazione::geometry) AS destinazione_lat`,
        [
          veicolo_id,
          clienteId,
          start_datetime,
          durataInterval,
          posti_richiesti,
          type,
          prezzo / slots.length,
          distanzaKm ?? 0,
          origine.lon,
          origine.lat,
          destinazione.lon,
          destinazione.lat,
          localitaOrigine,
          localitaDestinazione,
          paymentIntent.id,
          requestId,
          expiresAt
        ]
      );

      const row = result.rows[0];
      const pendingNormalized = {
        ...row,
        prezzo: Number(row.prezzo),
        distanza: Number(row.distanza),
        origine: { lat: row.origine_lat, lon: row.origine_lon },
        destinazione: { lat: row.destinazione_lat, lon: row.destinazione_lon },
        durataMinuti,
        posti_richiesti: row.posti_richiesti,
        startDisplayDate: formatNotificationDate(start_datetime)
      };
      pendingRows.push(pendingNormalized);

      // 🔹 Notifiche driver
      const veicoloRes = await pool.query('SELECT driver_id FROM veicolo WHERE id=$1', [veicolo_id]);
      const driverId = veicoloRes.rows[0]?.driver_id;
      if (driverId) {
        const messageDriver = generatePendingMessage({
          role: 'autista',
          startAddress: localitaOrigine,
          endAddress: localitaDestinazione,
          startDatetime: start_datetime
        });

        const notifDriverRes = await pool.query(
          `INSERT INTO notifications(user_id, type, message, seen, created_at)
           VALUES ($1, 'pending', $2, false, NOW()) RETURNING *`,
          [driverId, messageDriver]
        );

        const notifDriver = notifDriverRes.rows[0];
        notifDriver.displayDate = formatNotificationDate(new Date(notifDriver.created_at));

        // ✅ USO SOCKET.JS
        sendNotification({
          userId: driverId,
          role: 'autista',
          notification: notifDriver
        });

        try {
          const io = getIO();
          io.to(`autista_${driverId}`).emit('pending_update', {
            id: row.id,
            cliente: req.user.nome,
            origine: pendingNormalized.origine,
            destinazione: pendingNormalized.destinazione,
            origine_address: localitaOrigine,
            destinazione_address: localitaDestinazione,
            prezzo: pendingNormalized.prezzo,
            distanza: pendingNormalized.distanza,
            stato: row.stato,
            durataMinuti,
            posti_richiesti: row.posti_richiesti
          });
        } catch (err) {
          console.warn('⚠️ WS non disponibile:', err.message);
        }
      }

      // 🔹 Notifiche cliente
      const messageCliente = generatePendingMessage({
        role: 'cliente',
        startAddress: localitaOrigine,
        endAddress: localitaDestinazione,
        startDatetime: start_datetime
      });
      const notifClienteRes = await pool.query(
        `INSERT INTO notifications(user_id, type, message, seen, created_at)
         VALUES ($1, 'pending', $2, false, NOW()) RETURNING *`,
        [clienteId, messageCliente]
      );
      const notifCliente = notifClienteRes.rows[0];
      notifCliente.displayDate = formatNotificationDate(new Date(notifCliente.created_at));

      sendNotification({
        userId: clienteId,
        role: 'cliente',
        notification: notifCliente
      });
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