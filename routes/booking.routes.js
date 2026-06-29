import express from 'express';
import Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';
import { upsertPrenotazione } from '../services/search/search.cache.js';
import { notifyUser } from '../services/notifications/notification.service.js'; 

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

// ======================= ROUTE =======================
router.post('/payment-intent', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  const requestId = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 60000).toISOString(); 

  console.log(`💳 [PAYMENT:${requestId}] Inizio flusso per user: ${req.user.id}`);
  console.log(`📥 [PAYMENT:${requestId}] Payload ricevuto:`, JSON.stringify(req.body, null, 2));

  try {
    const { type, prezzo, slots } = req.body;

    if (!prezzo || prezzo <= 0) return res.status(400).json({ error: 'Prezzo non valido' });
    if (!slots || !Array.isArray(slots) || slots.length === 0) return res.status(400).json({ error: 'Slots mancanti' });

    const clienteId = req.user.id;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(prezzo * 100),
      currency: 'eur',
      metadata: { tipo: type, clienteId: clienteId.toString(), requestId },
      capture_method: 'manual',
    });
    
    await client.query('BEGIN');
    const pendingRows = [];

    for (const slot of slots) {
      console.log(`🔍 [PAYMENT:${requestId}] Analisi Slot: ID=${slot.id}, VeicoloID=${slot.veicolo_id}, is_pool=${slot.is_pool}`);

      const isPopBus = slot.is_pool === true || (slot.id && typeof slot.id === 'string' && (slot.id.startsWith('dir_') || slot.id === 'nuova_proposta' || slot.id.startsWith('virtual_pop_')));

      let savedRow;

      if (isPopBus) {
        const nodeRes = await client.query(
          `SELECT get_or_create_node($1, $2) as start, get_or_create_node($3, $4) as end`, 
          [slot.origine.lat, slot.origine.lon, slot.destinazione.lat, slot.destinazione.lon]
        );

        const result = await client.query(
          `INSERT INTO richieste_pop_bus (
            cliente_id, origine, destinazione, start_datetime, posti_richiesti, stato,
            start_node_id, end_node_id
          )
            VALUES (
            $1,
            ST_SetSRID(ST_MakePoint($2,$3),4326),
            ST_SetSRID(ST_MakePoint($4,$5),4326),
            $6, $7, 'in_attesa', $8, $9
          ) RETURNING *`,
          [
            clienteId,
            slot.origine.lon, slot.origine.lat,
            slot.destinazione.lon, slot.destinazione.lat,
            slot.start_datetime,
            slot.posti_richiesti,
            nodeRes.rows[0].start,
            nodeRes.rows[0].end
          ]
        );

        savedRow = result.rows[0];

      } else {
        // --- CONTROLLO DI INTEGRITÀ PRE-QUERY ---
        if (slot.veicolo_id === undefined || slot.veicolo_id === null) {
          console.error(`🚨 [PAYMENT:${requestId}] ERRORE CRITICO: Lo slot ${slot.id} non ha veicolo_id!`);
          throw new Error(`Dato corrotto: veicolo_id mancante per lo slot ${slot.id}`);
        }

        const distanza = slot.distanzaKm || 0;
        const durata = slot.durata_minuti || 0;

        const result = await client.query(
          `INSERT INTO pending (
            veicolo_id, cliente_id, start_datetime, posti_richiesti, tipo_corsa, prezzo, 
            distanza, durata, expires_at, origine, destinazione, stato, payment_intent_id, request_id
          )
            VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            ST_SetSRID(ST_MakePoint($10,$11),4326),
            ST_SetSRID(ST_MakePoint($12,$13),4326),
            'pending', $14, $15
          ) RETURNING *`,
          [
            slot.veicolo_id,
            clienteId,
            slot.start_datetime,
            slot.posti_richiesti,
            type,
            (prezzo / slots.length),
            distanza,
            durata,
            expiresAt,
            slot.origine.lon,
            slot.origine.lat,
            slot.destinazione.lon,
            slot.destinazione.lat,
            paymentIntent.id,
            requestId
          ]
        );

        savedRow = result.rows[0];
        await upsertPrenotazione(savedRow);
      }
      
      pendingRows.push(savedRow);
      console.log(`📝 [PAYMENT:${requestId}] Record inserito correttamente: ${savedRow.id}`);

      // ================= NOTIFICA DRIVER / ADMIN =================
      try {
        const adminRes = await pool.query(
          "SELECT id FROM utente WHERE tipo = 'admin' ORDER BY id LIMIT 1"
        );

        const adminId = adminRes.rows[0]?.id;
        const targetId = savedRow.autista_id || adminId;

        if (!targetId || Number.isNaN(Number(targetId))) {
          throw new Error(`targetId non valido: ${targetId}`);
        }

        const role = savedRow.autista_id ? 'driver' : 'admin';
        console.log(`🔔 [NOTIFY_ADMIN] Invio notifica a ${role} (${targetId})...`);

        await notifyUser(Number(targetId), {
          type: 'NEW_REQUEST',
          message: `Nuova richiesta di prenotazione ricevuta`,
          role,
          data: { requestId, rowId: savedRow.id, type }
        });

      } catch (notifyErr) {
        console.error(`⚠️ [NOTIFY_ADMIN] Errore notifica:`, notifyErr);
      }

      // ================= NOTIFICA CLIENTE =================
      try {
        console.log(`🔔 [NOTIFY_CLIENT] Invio notifica a cliente (${clienteId})...`);
        await notifyUser(Number(clienteId), {
          type: 'REQUEST_CREATED',
          message: `La tua richiesta è stata inviata correttamente`,
          role: 'cliente',
          data: { requestId, rowId: savedRow.id, type }
        });
      } catch (notifyErr) {
        console.error(`⚠️ [NOTIFY_CLIENT] Errore notifica:`, notifyErr);
      }
    }

    await client.query('COMMIT');
    console.log(`✅ [PAYMENT:${requestId}] Transazione completata.`);
    res.json({ clientSecret: paymentIntent.client_secret, pending: pendingRows, requestId });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`❌ [PAYMENT:${requestId}] Errore critico:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;