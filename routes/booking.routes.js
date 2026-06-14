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
    
    await client.query('BEGIN');
    const pendingRows = [];

    for (const slot of slots) {
      const isPopBus = slot.is_pool === true || 
                       (slot.id && typeof slot.id === 'string' && (slot.id.startsWith('dir_') || slot.id === 'nuova_proposta'));

      if (isPopBus) {
        console.log(`🚌 [POOL] Inserimento richiesta Pop-Bus con risoluzione dinamica nodi...`);
        
        // Risoluzione dinamica: la funzione SQL crea il nodo se non esiste entro 500m
        const nodeRes = await client.query(`
          SELECT 
            get_or_create_node($1, $2) as start_node,
            get_or_create_node($3, $4) as end_node
        `, [slot.origine.lat, slot.origine.lon, slot.destinazione.lat, slot.destinazione.lon]);

        const { start_node, end_node } = nodeRes.rows[0];

        const result = await client.query(
          `INSERT INTO richieste_pop_bus (cliente_id, origine, destinazione, start_datetime, posti_richiesti, stato, start_node_id, end_node_id)
           VALUES ($1, ST_SetSRID(ST_MakePoint($2,$3),4326), ST_SetSRID(ST_MakePoint($4,$5),4326), $6, $7, 'in_attesa', $8, $9)
           RETURNING id`,
          [clienteId, slot.origine.lon, slot.origine.lat, slot.destinazione.lon, slot.destinazione.lat, slot.start_datetime, slot.posti_richiesti, start_node, end_node]
        );
        
        const richiestaId = result.rows[0].id;

        if (slot.direttrice_id && typeof slot.direttrice_id === 'string' && slot.direttrice_id.startsWith('dir_')) {
          const dirId = parseInt(slot.direttrice_id.replace('dir_', ''));
          await client.query(
            `INSERT INTO direttrici_richieste (direttrice_id, richiesta_id) VALUES ($1, $2)`,
            [dirId, richiestaId]
          );
        }
        pendingRows.push({ id: richiestaId, is_pool: true, stato: 'in_attesa' });
      } else {
        // Logica Corsa Privata
        let vId = slot.veicolo_id || (slot.id?.startsWith('priv_') ? slot.id.split('_')[1] : null);
        if (!vId) throw new Error("Veicolo ID mancante per corsa privata");
        
        const result = await client.query(
          `INSERT INTO pending (veicolo_id, cliente_id, start_datetime, posti_richiesti, tipo_corsa, prezzo, distanza, origine, destinazione, stato, payment_intent_id, request_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7, ST_SetSRID(ST_MakePoint($8,$9),4326), ST_SetSRID(ST_MakePoint($10,$11),4326), 'pending',$12,$13)
           RETURNING *`,
          [vId, clienteId, slot.start_datetime, slot.posti_richiesti, type, prezzo/slots.length, slot.distanzaKm || 0, slot.origine.lon, slot.origine.lat, slot.destinazione.lon, slot.destinazione.lat, paymentIntent.id, requestId]
        );
        
        pendingRows.push(result.rows[0]);
        await upsertPrenotazione(result.rows[0]);
      }
    }

    await client.query('COMMIT');
    console.log(`✅ [PAYMENT] Transazione completata. Nodi risolti dinamicamente.`);

    res.json({ clientSecret: paymentIntent.client_secret, pending: pendingRows, requestId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [PAYMENT] Errore:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;