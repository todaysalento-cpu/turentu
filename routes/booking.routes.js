import express from 'express';
import Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';
import { sendNotification } from '../socket.js';
import { getDurataDistanza } from '../utils/maps.util.js';
import { upsertPrenotazione } from '../services/search/search.cache.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

// ======================= HELPERS =======================
function generatePendingMessage({ role, startAddress, endAddress, startDatetime }) {
  const formatStart = (input) => {
    if (!input) return '';
    const d = new Date(input);
    if (isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    return `${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} alle ${time}`;
  };
  
  const timeStr = formatStart(startDatetime);
  if (role === 'autista') return `Nuova Richiesta - ${startAddress} → ${endAddress} - ${timeStr}`;
  return `Hai richiesto una nuova prenotazione 🏁 ${startAddress} → ${endAddress} - ${timeStr}`;
}

// ======================= ROUTE =======================
router.post('/payment-intent', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  const notificheDaInviare = [];
  console.log(`💳 [PAYMENT] Inizio flusso per user: ${req.user.id}`);

  try {
    const { type, prezzo, slots } = req.body;

    if (!prezzo || prezzo <= 0) return res.status(400).json({ error: 'Prezzo non valido' });
    if (!slots || !Array.isArray(slots) || slots.length === 0) return res.status(400).json({ error: 'Slots mancanti' });

    const clienteId = req.user.id;
    const requestId = uuidv4();

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(prezzo * 100),
      currency: 'eur',
      metadata: { tipo: type, clienteId: clienteId.toString(), requestId },
      capture_method: 'manual',
    });
    console.log(`💳 [STRIPE] Intent creato: ${paymentIntent.id}`);

    await client.query('BEGIN');
    const pendingRows = [];

    for (const slot of slots) {
      const { 
        veicolo_id, is_pool, start_datetime, posti_richiesti, 
        origine, destinazione, localitaOrigine, localitaDestinazione, distanzaKm 
      } = slot;
      
      if (!origine?.lat || !destinazione?.lat) throw new Error("Coordinate incomplete");

      if (is_pool) {
        console.log(`🚌 [POOL] Inserimento richiesta Pop-Bus`);
        const result = await client.query(
          `INSERT INTO richieste_pop_bus (cliente_id, origine, destinazione, start_datetime, posti_richiesti, stato)
           VALUES ($1, ST_SetSRID(ST_MakePoint($2,$3),4326), ST_SetSRID(ST_MakePoint($4,$5),4326), $6, $7, 'in_attesa')
           RETURNING *`,
          [clienteId, origine.lon, origine.lat, destinazione.lon, destinazione.lat, start_datetime, posti_richiesti]
        );
        pendingRows.push({ ...result.rows[0], is_pool: true });
      } else {
        console.log(`🚗 [PRIVATE] Elaborazione corsa privata per veicolo: ${veicolo_id}`);
        let durataMinuti = slot.durataMinuti ?? slot.durata_minuti ?? 30;
        let dist = Number(distanzaKm ?? 0);
        
        if (dist <= 0) {
          const geo = await getDurataDistanza(origine, destinazione).catch(() => ({ distanzaKm: 0 }));
          dist = Number(geo.distanzaKm ?? 0);
        }

        const result = await client.query(
          `INSERT INTO pending (veicolo_id, cliente_id, start_datetime, durata, posti_richiesti, tipo_corsa, prezzo, distanza, origine, destinazione, origine_address, destinazione_address, stato, payment_intent_id, request_id, expires_at)
           VALUES ($1,$2,$3,$4::interval,$5,$6,$7,$8, ST_SetSRID(ST_MakePoint($9,$10),4326), ST_SetSRID(ST_MakePoint($11,$12),4326), $13,$14,'pending',$15,$16::uuid, NOW() + interval '30 minutes')
           RETURNING *`,
          [veicolo_id, clienteId, start_datetime, `${durataMinuti} minutes`, posti_richiesti, type, prezzo / slots.length, dist, origine.lon, origine.lat, destinazione.lon, destinazione.lat, localitaOrigine, localitaDestinazione, paymentIntent.id, requestId]
        );
        
        const pItem = result.rows[0];
        pendingRows.push(pItem);
        await upsertPrenotazione(pItem);

        // Notifiche
        const driverRes = await client.query('SELECT driver_id FROM veicolo WHERE id=$1', [veicolo_id]);
        const driverId = driverRes.rows[0]?.driver_id;
        
        if (driverId) {
          console.log(`🔔 [NOTIF] Inserimento notifica DB per Autista ID: ${driverId}`);
          const notif = await client.query(
            `INSERT INTO notifications(user_id, type, message, seen, created_at) VALUES ($1, 'pending', $2, false, NOW()) RETURNING *`, 
            [driverId, generatePendingMessage({ role: 'autista', startAddress: localitaOrigine, endAddress: localitaDestinazione, startDatetime: start_datetime })]
          );
          notificheDaInviare.push({ userId: driverId, notification: notif.rows[0] });
        } else {
          console.warn(`⚠️ [NOTIF] Driver non trovato per veicolo ${veicolo_id}`);
        }
      }
    }

    await client.query('COMMIT');
    console.log(`✅ [PAYMENT] Transazione completata.`);

    // Invio notifiche socket
    for (const notifData of notificheDaInviare) {
      console.log(`🚀 [SOCKET] Invio notifica real-time a Autista: ${notifData.userId}`);
      sendNotification({ userId: notifData.userId, role: 'autista', notification: notifData.notification });
    }

    res.json({ clientSecret: paymentIntent.client_secret, pending: pendingRows, requestId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [PAYMENT] Errore critico:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;