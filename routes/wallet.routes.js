import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';
import { upsertPrenotazione } from '../services/search/search.cache.js';
import { notifyUser } from '../services/notifications/notification.service.js'; 
import Stripe from 'stripe';

const router = express.Router();

// Inizializza Stripe con la tua chiave segreta presa dalle variabili d'ambiente
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ======================= ROUTE GET SALDO =======================
router.get('/saldo', authMiddleware, async (req, res) => {
  try {
    const clienteId = req.user.id;
    
    const saldoRes = await pool.query(
      'SELECT COALESCE(SUM(importo), 0) AS saldo_attuale FROM transazioni_wallet WHERE utente_id = $1',
      [clienteId]
    );

    const saldo = parseFloat(saldoRes.rows[0].saldo_attuale || 0);

    return res.json({
      success: true,
      saldo_attuale: saldo
    });
  } catch (error) {
    console.error("❌ [WALLET-SALDO] Errore calcolo saldo da transazioni:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ======================= ROUTE INIZIALIZZAZIONE RICARICA (STRIPE) =======================
router.post('/ricarica/init', authMiddleware, async (req, res) => {
  const requestId = uuidv4();

  try {
    const { importo } = req.body;
    const clienteId = req.user.id;

    if (!importo || importo <= 0) {
      return res.status(400).json({ success: false, error: 'Importo non valido' });
    }

    console.log(`💳 [RICARICA-INIT:${requestId}] Richiesta Stripe PaymentIntent per €${importo}, utente ${clienteId}`);

    // Stripe richiede l'importo in centesimi (es. 20 euro = 2000 centesimi)
    const amountInCents = Math.round(parseFloat(importo) * 100);

    // 1. Crea il PaymentIntent su Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'eur',
      metadata: {
        clienteId: clienteId.toString(),
        tipo: 'RICARICA_WALLET'
      },
      automatic_payment_methods: { enabled: true },
    });

    console.log(`✅ [RICARICA-INIT:${requestId}] PaymentIntent creato con successo: ${paymentIntent.id}`);

    // Restituisce il client_secret necessario all'app mobile per aprire la schermata di pagamento di Stripe
    return res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      importo
    });

  } catch (error) {
    console.error(`❌ [RICARICA-INIT:${requestId}] Errore Stripe:`, error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ======================= ROUTE CONFERMA RICARICA (OPZIONALE MA UTILE) =======================
// Da chiamare dall'app mobile dopo che il pagamento con Stripe è andato a buon fine, 
// oppure puoi farlo gestire in automatico tramite i Webhook di Stripe.
router.post('/ricarica/conferma', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  const requestId = uuidv4();

  try {
    const { paymentIntentId, importo } = req.body;
    const clienteId = req.user.id;

    if (!paymentIntentId || !importo) {
      return res.status(400).json({ success: false, error: 'Dati pagamento mancanti' });
    }

    // Verifica lo stato direttamente da Stripe per sicurezza
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ success: false, error: 'Il pagamento non è stato completato su Stripe' });
    }

    await client.query('BEGIN');

    // Controlla che questa transazione non sia già stata registrata (prevenzione doppie ricariche)
    const checkRes = await client.query(
      'SELECT id FROM transazioni_wallet WHERE riferimento_id = $1',
      [paymentIntentId]
    );

    if (checkRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Transazione già registrata' });
    }

    // Registra la ricarica effettiva nel database
    const transazioneRes = await client.query(
      'INSERT INTO transazioni_wallet (utente_id, importo, tipo, riferimento_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [clienteId, parseFloat(importo), 'RICARICA_WALLET', paymentIntentId]
    );

    const transazioneId = transazioneRes.rows[0].id;

    // Ricalcola il saldo aggiornato
    const saldoRes = await client.query(
      'SELECT COALESCE(SUM(importo), 0) AS saldo_attuale FROM transazioni_wallet WHERE utente_id = $1',
      [clienteId]
    );

    const nuovoSaldo = parseFloat(saldoRes.rows[0].saldo_attuale || 0);

    await client.query('COMMIT');

    console.log(`✅ [RICARICA-CONFERMA:${requestId}] Credito caricato. Utente: ${clienteId}, Importo: €${importo}`);

    return res.json({
      success: true,
      message: 'Ricarica accreditata con successo',
      nuovo_saldo: nuovoSaldo
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`❌ [RICARICA-CONFERMA:${requestId}] Errore:`, error);
    return res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// ======================= ROUTE PAGAMENTO WALLET =======================
router.post('/payment-wallet', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  const requestId = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 60000).toISOString(); 

  console.log(`👛 [WALLET-PAYMENT:${requestId}] Inizio flusso per user: ${req.user.id}`);
  console.log(`📥 [WALLET-PAYMENT:${requestId}] Payload ricevuto:`, JSON.stringify(req.body, null, 2));

  try {
    const { type, prezzo, slots } = req.body;

    if (!prezzo || prezzo <= 0) return res.status(400).json({ error: 'Prezzo non valido' });
    if (!slots || !Array.isArray(slots) || slots.length === 0) return res.status(400).json({ error: 'Slots mancanti' });

    const clienteId = req.user.id;

    await client.query('BEGIN');

    const saldoRes = await client.query(
      'SELECT COALESCE(SUM(importo), 0) AS saldo_attuale FROM transazioni_wallet WHERE utente_id = $1 FOR UPDATE',
      [clienteId]
    );

    const saldoDisponibile = parseFloat(saldoRes.rows[0].saldo_attuale || 0);

    if (saldoDisponibile < parseFloat(prezzo)) {
      await client.query('ROLLBACK');
      console.log(`❌ [WALLET-PAYMENT:${requestId}] Credito insufficiente. Saldo: ${saldoDisponibile}, Richiesto: ${prezzo}`);
      return res.status(400).json({ 
        error: 'Credito wallet insufficiente', 
        saldo_attuale: saldoDisponibile,
        costo_richiesto: prezzo 
      });
    }

    const transazioneRes = await client.query(
      'INSERT INTO transazioni_wallet (utente_id, importo, tipo, riferimento_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [clienteId, -parseFloat(prezzo), 'SCALATURA_CORSA', null]
    );
    const transazioneWalletId = transazioneRes.rows[0].id;

    const pendingRows = [];

    for (const slot of slots) {
      console.log(`🔍 [WALLET-PAYMENT:${requestId}] Analisi Slot: ID=${slot.id}, VeicoloID=${slot.veicolo_id}, is_pool=${slot.is_pool}`);
      
      console.log(`⏰ [DEBUG-DATE:${requestId}] Slot ${slot.id} - start_datetime grezzo dal client:`, slot.start_datetime);
      console.log(`⏰ [DEBUG-DATE:${requestId}] Interpretato in ISO dal server:`, new Date(slot.start_datetime).toISOString());

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
        if (slot.veicolo_id === undefined || slot.veicolo_id === null) {
          console.error(`🚨 [WALLET-PAYMENT:${requestId}] ERRORE CRITICO: Lo slot ${slot.id} non ha veicolo_id!`);
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
            'confermata', $14, $15
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
            `wallet_${transazioneWalletId}`,
            requestId
          ]
        );

        savedRow = result.rows[0];
        await upsertPrenotazione(savedRow);
      }
      
      pendingRows.push(savedRow);
      console.log(`📝 [WALLET-PAYMENT:${requestId}] Record inserito correttamente: ${savedRow.id}`);

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
          message: `Nuova richiesta di prenotazione pagata con Wallet`,
          role,
          data: { 
            requestId, 
            rowId: savedRow.id, 
            type, 
            start_datetime: slot.start_datetime 
          }
        });

      } catch (notifyErr) {
        console.error(`⚠️ [NOTIFY_ADMIN] Errore notifica:`, notifyErr);
      }

      // ================= NOTIFICA CLIENTE =================
      try {
        console.log(`🔔 [NOTIFY_CLIENT] Invio notifica a cliente (${clienteId})...`);
        
        await notifyUser(Number(clienteId), {
          type: 'REQUEST_CREATED',
          message: `La tua prenotazione è stata pagata e confermata con il wallet`,
          role: 'cliente',
          data: { 
            requestId, 
            rowId: savedRow.id, 
            type, 
            start_datetime: slot.start_datetime 
          }
        });
      } catch (notifyErr) {
        console.error(`⚠️ [NOTIFY_CLIENT] Errore notifica:`, notifyErr);
      }
    }

    await client.query('COMMIT');
    console.log(`✅ [WALLET-PAYMENT:${requestId}] Transazione wallet completata con successo.`);
    
    res.json({ 
      success: true, 
      message: 'Pagamento effettuato con successo tramite wallet',
      pending: pendingRows, 
      requestId,
      nuovo_saldo: saldoDisponibile - parseFloat(prezzo)
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`❌ [WALLET-PAYMENT:${requestId}] Errore critico:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;