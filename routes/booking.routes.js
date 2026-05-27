import express from 'express';
import Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';
import { sendNotification, getIO } from '../socket.js';
import { sendPush } from '../services/notifications/push.service.js';
import { getDurataDistanza } from '../utils/maps.util.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

// ======================= HELPERS =======================
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

// ======================= ROUTE =======================
router.post('/payment-intent', authMiddleware, async (req, res) => {
  try {
    const { type, prezzo, slots } = req.body;

    if (!prezzo || prezzo <= 0) return res.status(400).json({ error: 'Prezzo non valido' });
    if (!type || !['prenota', 'richiedi'].includes(type)) return res.status(400).json({ error: 'Tipo pagamento non valido' });
    if (!slots || !Array.isArray(slots) || slots.length === 0) return res.status(400).json({ error: 'Slots mancanti' });

    const clienteId = req.user.id;
    const requestId = uuidv4();

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(prezzo * 100),
      currency: 'eur',
      description: type === 'prenota' ? 'Prenotazione TURENTU' : 'Richiesta TURENTU',
      metadata: { tipo: type, clienteId: clienteId.toString(), requestId },
      capture_method: 'manual',
    });

    const pendingRows = [];

    for (const slot of slots) {
      let {
        veicolo_id, start_datetime, posti_richiesti, origine, destinazione,
        localitaOrigine, localitaDestinazione, distanzaKm
      } = slot;

      let durataMinuti = slot.durataMinuti ?? slot.durata_minuti;

      if (!durataMinuti || durataMinuti <= 0) throw new Error("Durata non valida");
      if (!origine?.lat || !origine?.lon || !destinazione?.lat || !destinazione?.lon) throw new Error("Coordinate mancanti");
      if (!localitaOrigine || !localitaDestinazione) throw new Error("Indirizzi mancanti");

      let dist = Number(distanzaKm ?? 0);
      if (dist <= 0) {
        try {
          const geo = await getDurataDistanza(origine, destinazione);
          dist = Number(geo.distanzaKm ?? 0);
        } catch (e) {
          console.error("Errore ricalcolo distanza:", e);
        }
      }

      const durataInterval = `${durataMinuti} minutes`;
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const prezzoSlot = prezzo / slots.length;

      // 1. Inserimento in pending
      const result = await pool.query(
        `INSERT INTO pending
        (veicolo_id, cliente_id, start_datetime, durata, posti_richiesti,
         tipo_corsa, prezzo, distanza, origine, destinazione,
         origine_address, destinazione_address, stato, payment_intent_id, request_id, expires_at)
         VALUES ($1,$2,$3,$4::interval,$5,$6,$7,$8,
                 ST_SetSRID(ST_MakePoint($9,$10),4326),
                 ST_SetSRID(ST_MakePoint($11,$12),4326),
                 $13,$14,'pending',$15,$16::uuid,$17)
         RETURNING *`,
        [veicolo_id, clienteId, start_datetime, durataInterval, posti_richiesti, type, 
         prezzoSlot, dist, origine.lon, origine.lat, destinazione.lon, 
         destinazione.lat, localitaOrigine, localitaDestinazione, paymentIntent.id, requestId, expiresAt]
      );

      const pendingRecord = result.rows[0];
      pendingRows.push(pendingRecord);

      // 2. 🔥 AGGIUNTA: Tracciamento immediato in pagamenti
      await pool.query(
        `INSERT INTO pagamenti (prenotazione_id, importo, stato, stripe_payment_intent, updated_at) 
         VALUES ($1, $2, 'autorizzazione', $3, NOW())`,
        [pendingRecord.id, prezzoSlot, paymentIntent.id]
      );

      // 3. Notifiche
      const messageDriver = generatePendingMessage({ role: 'autista', startAddress: localitaOrigine, endAddress: localitaDestinazione, startDatetime: start_datetime });
      const messageCliente = generatePendingMessage({ role: 'cliente', startAddress: localitaOrigine, endAddress: localitaDestinazione, startDatetime: start_datetime });

      const driverRes = await pool.query('SELECT driver_id FROM veicolo WHERE id=$1', [veicolo_id]);
      const driverId = driverRes.rows[0]?.driver_id;

      if (driverId) {
        const notifDriver = await pool.query(`INSERT INTO notifications(user_id, type, message, seen, created_at) VALUES ($1, 'pending', $2, false, NOW()) RETURNING *`, [driverId, messageDriver]);
        sendNotification({ userId: driverId, role: 'autista', notification: notifDriver.rows[0] });
        const driverTokens = await pool.query(`SELECT push_token FROM utente_push_tokens WHERE user_id=$1`, [driverId]);
        for (const t of driverTokens.rows) await sendPush(t.push_token, 'Nuova richiesta 🚖', messageDriver, { type: 'pending', requestId });
      }

      const notifCliente = await pool.query(`INSERT INTO notifications(user_id, type, message, seen, created_at) VALUES ($1, 'pending', $2, false, NOW()) RETURNING *`, [clienteId, messageCliente]);
      sendNotification({ userId: clienteId, role: 'cliente', notification: notifCliente.rows[0] });
      const clienteTokens = await pool.query(`SELECT push_token FROM utente_push_tokens WHERE user_id=$1`, [clienteId]);
      for (const t of clienteTokens.rows) await sendPush(t.push_token, 'Prenotazione creata 🏁', messageCliente, { type: 'pending', requestId });
    }

    res.json({ clientSecret: paymentIntent.client_secret, pending: pendingRows, requestId });
  } catch (err) {
    console.error('❌ Stripe PaymentIntent error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;