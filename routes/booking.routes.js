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
    const { type, prezzo, slots, usaWallet } = req.body;

    if (!prezzo || prezzo <= 0) {
      console.warn(`⚠️ [PAYMENT:${requestId}] Prezzo non valido: ${prezzo}`);
      return res.status(400).json({ error: 'Prezzo non valido' });
    }
    if (!slots || !Array.isArray(slots) || slots.length === 0) {
      console.warn(`⚠️ [PAYMENT:${requestId}] Slots mancanti o non validi`);
      return res.status(400).json({ error: 'Slots mancanti' });
    }

    const clienteId = req.user.id;
    let pagatoConWallet = false;

    // ================= CONTROLLO E GESTIONE WALLET =================
    if (usaWallet) {
      console.log(`👛 [PAYMENT:${requestId}] Controllo saldo wallet per utente: ${clienteId}`);
      const saldoRes = await client.query(
        'SELECT COALESCE(SUM(importo), 0) AS saldo_attuale FROM transazioni_wallet WHERE utente_id = $1',
        [clienteId]
      );
      const saldoAttuale = parseFloat(saldoRes.rows[0]?.saldo_attuale || 0);

      if (saldoAttuale >= parseFloat(prezzo)) {
        console.log(`👛 [PAYMENT:${requestId}] Saldo sufficiente (€${saldoAttuale}). Utilizzo il wallet per €${prezzo}.`);
        pagatoConWallet = true;
      } else {
        console.log(`👛 [PAYMENT:${requestId}] Saldo insufficiente (€${saldoAttuale} < €${prezzo}). Ripiego su Stripe.`);
      }
    }

    let paymentIntent = null;

    if (!pagatoConWallet) {
      console.log(`💳 [PAYMENT:${requestId}] Creazione Stripe PaymentIntent per importo: €${prezzo}`);
      paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(prezzo * 100),
        currency: 'eur',
        metadata: { tipo: type, clienteId: clienteId.toString(), requestId },
        capture_method: 'manual',
      });
      console.log(`💳 [PAYMENT:${requestId}}] Stripe PaymentIntent creato con ID: ${paymentIntent.id}`);
    }
    
    await client.query('BEGIN');
    console.log(`🔄 [PAYMENT:${requestId}] Transazione SQL avviata (BEGIN)`);

    const pendingRows = [];

    if (pagatoConWallet) {
      console.log(`📝 [PAYMENT:${requestId}] Inserimento transazione wallet nel DB...`);
      await client.query(
        `INSERT INTO transazioni_wallet (utente_id, tipo, importo, riferimento_id) 
         VALUES ($1, 'pagamento_corsa', $2, $3)`,
        [clienteId, -parseFloat(prezzo), requestId]
      );
      console.log(`✅ [PAYMENT:${requestId}] Transazione wallet registrata.`);
    }

    // 🔒 GESTIONE SLOT UNICO E ESTRAZIONE INDIRIZZI
    const slot = slots[0];
    
    const origineAddress = slot.origine_address || slot.origineAddress || (slot.origine?.lat ? `Posizione (${slot.origine.lat.toFixed(4)}, ${slot.origine.lon.toFixed(4)})` : 'Partenza');
    const destinazioneAddress = slot.destinazione_address || slot.destinazioneAddress || (slot.destinazione?.lat ? `Destinazione (${slot.destinazione.lat.toFixed(4)}, ${slot.destinazione.lon.toFixed(4)})` : 'Arrivo');

    console.log(`🔍 [PAYMENT:${requestId}] Analisi Slot Unico: ID=${slot.id}, VeicoloID=${slot.veicolo_id}, is_pool=${slot.is_pool}`);

    const isPopBus = slot.is_pool === true || (slot.id && typeof slot.id === 'string' && (slot.id.startsWith('dir_') || slot.id === 'nuova_proposta' || slot.id.startsWith('virtual_pop_')));

    let savedRow;

    if (isPopBus) {
      console.log(`🗺️ [DEBUG-NODES:${requestId}] Chiamata get_or_create_node con coordinate origine: (${slot.origine.lat}, ${slot.origine.lon}) e destinazione: (${slot.destinazione.lat}, ${slot.destinazione.lon})`);

      const nodeRes = await client.query(
        `SELECT get_or_create_node($1, $2) as start, get_or_create_node($3, $4) as end`, 
        [slot.origine.lat, slot.origine.lon, slot.destinazione.lat, slot.destinazione.lon]
      );

      console.log(`🗺️ [DEBUG-NODES:${requestId}] Nodi restituiti dal DB -> start_node_id: ${nodeRes.rows[0]?.start}, end_node_id: ${nodeRes.rows[0]?.end}`);

      const result = await client.query(
        `INSERT INTO richieste_pop_bus (
          cliente_id, origine, destinazione, start_datetime, posti_richiesti, stato,
          start_node_id, end_node_id, classe, origine_address, destinazione_address
        )
          VALUES (
          $1,
          ST_SetSRID(ST_MakePoint($2,$3),4326),
          ST_SetSRID(ST_MakePoint($4,$5),4326),
          $6, $7, 'in_attesa', $8, $9, $10, $11, $12
        ) RETURNING *`,
        [
          clienteId,
          slot.origine.lon, slot.origine.lat,
          slot.destinazione.lon, slot.destinazione.lat,
          slot.start_datetime,
          slot.posti_richiesti || 1,
          nodeRes.rows[0].start,
          nodeRes.rows[0].end,
          slot.classe || 'STANDARD',
          origineAddress,
          destinazioneAddress
        ]
      );

      savedRow = result.rows[0];
      console.log(`✅ [DEBUG-INSERT:${requestId}] Inserimento richieste_pop_bus completato con ID: ${savedRow.id}`);

    } else {
      if (slot.veicolo_id === undefined || slot.veicolo_id === null) {
        console.error(`🚨 [PAYMENT:${requestId}] ERRORE CRITICO: Lo slot ${slot.id} non ha veicolo_id!`);
        throw new Error(`Dato corrotto: veicolo_id mancante per lo slot ${slot.id}`);
      }

      const distanza = slot.distanzaKm || 0;
      const durata = slot.durata_minuti || 0;

      // Estraiamo l'ID della corsa dallo slot se si sta agganciando a una corsa condivisa esistente
      const corsaIdToSave = (slot.id && !isNaN(Number(slot.id))) ? Number(slot.id) : (slot.corsa_id || null);

      console.log(`🚗 [DEBUG-INSERT:${requestId}] Inserimento nella tabella pending per veicolo_id: ${slot.veicolo_id}, corsa_id: ${corsaIdToSave}`);

      const result = await client.query(
        `INSERT INTO pending (
          veicolo_id, cliente_id, start_datetime, posti_richiesti, tipo_corsa, prezzo, 
          distanza, durata, expires_at, origine, destinazione, stato, payment_intent_id, request_id,
          origine_address, destinazione_address, corsa_id
        )
          VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          ST_SetSRID(ST_MakePoint($10,$11),4326),
          ST_SetSRID(ST_MakePoint($12,$13),4326),
          'pending', $14, $15, $16, $17, $18
        ) RETURNING *`,
        [
          slot.veicolo_id,
          clienteId,
          slot.start_datetime,
          slot.posti_richiesti || 1,
          type,
          prezzo,
          distanza,
          durata,
          expiresAt,
          slot.origine.lon,
          slot.origine.lat,
          slot.destinazione.lon,
          slot.destinazione.lat,
          pagatoConWallet ? `wallet_${requestId}` : paymentIntent.id,
          requestId,
          origineAddress,
          destinazioneAddress,
          corsaIdToSave
        ]
      );

      savedRow = result.rows[0];
      console.log(`✅ [DEBUG-INSERT:${requestId}] Inserimento pending completato con ID: ${savedRow.id}`);

      console.log(`📦 [DEBUG-CACHE:${requestId}] Aggiornamento cache prenotazioni per ID: ${savedRow.id}`);
      await upsertPrenotazione(savedRow);
    }
    
    pendingRows.push(savedRow);
    console.log(`📝 [PAYMENT:${requestId}] Record inserito correttamente: ${savedRow.id}`);

    // ================= NOTIFICA DRIVER / AUTISTA =================
    try {
      console.log(`📢 [NOTIFY_DRIVER:${requestId}] Ricerca autista per invio notifica (Veicolo ID: ${slot.veicolo_id})...`);
      
      let driverId = savedRow.driver_id || savedRow.autista_id;

      if (!driverId && slot.veicolo_id) {
        const veicoloRes = await client.query(
          "SELECT driver_id FROM veicolo WHERE id = $1",
          [slot.veicolo_id]
        );
        driverId = veicoloRes.rows[0]?.driver_id;
      }

      if (driverId && !Number.isNaN(Number(driverId))) {
        console.log(`📢 [NOTIFY_DRIVER:${requestId}] Invio notifica all'autista ID: ${driverId}`);
        await notifyUser(Number(driverId), {
          type: 'NEW_REQUEST',
          message: `Hai ricevuto una nuova richiesta di prenotazione!`,
          role: 'driver',
          data: { requestId, rowId: savedRow.id, type, start_datetime: slot.start_datetime }
        });
        console.log(`✅ [NOTIFY_DRIVER:${requestId}] Notifica autista inviata.`);
      } else {
        console.log(`⚠️ [NOTIFY_DRIVER:${requestId}] Nessun driver_id trovato per il veicolo.`);
      }
    } catch (notifyErr) {
      console.error(`⚠️ [NOTIFY_DRIVER:${requestId}] Errore durante l'invio della notifica all'autista:`, notifyErr);
    }

    // ================= NOTIFICA CLIENTE =================
    try {
      console.log(`📢 [NOTIFY_CLIENT:${requestId}] Invio notifica di conferma al cliente ID: ${clienteId}`);
      await notifyUser(Number(clienteId), {
        type: 'REQUEST_CREATED',
        message: `La tua richiesta è stata inviata correttamente`,
        role: 'cliente',
        data: { requestId, rowId: savedRow.id, type, start_datetime: slot.start_datetime }
      });
      console.log(`✅ [NOTIFY_CLIENT:${requestId}] Notifica cliente inviata.`);
    } catch (notifyErr) {
      console.error(`⚠️ [NOTIFY_CLIENT:${requestId}] Errore durante l'invio della notifica cliente:`, notifyErr);
    }

    await client.query('COMMIT');
    console.log(`✅ [PAYMENT:${requestId}] Transazione SQL completata con successo (COMMIT).`);

    res.json({ 
      pagatoConWallet, 
      clientSecret: pagatoConWallet ? null : paymentIntent.client_secret, 
      pending: pendingRows, 
      requestId 
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`❌ [PAYMENT:${requestId}] Errore critico intercettato. Rollback eseguito. Dettagli:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
    console.log(`🔌 [PAYMENT:${requestId}] Connessione al database rilasciata.`);
  }
});

export default router;