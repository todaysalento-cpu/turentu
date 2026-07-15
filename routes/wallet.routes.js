import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';
import { upsertPrenotazione } from '../services/search/search.cache.js';
import { notifyUser } from '../services/notifications/notification.service.js'; 

const router = express.Router();

// ======================= ROUTE WALLET =======================
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

    // 1. Controllo e blocco del saldo utente (SELECT FOR UPDATE per evitare race conditions)
    const utenteRes = await client.query(
      'SELECT saldo_wallet FROM utente WHERE id = $1 FOR UPDATE',
      [clienteId]
    );

    if (utenteRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Utente non trovato' });
    }

    const saldoDisponibile = parseFloat(utenteRes.rows[0].saldo_wallet || 0);

    if (saldoDisponibile < parseFloat(prezzo)) {
      await client.query('ROLLBACK');
      console.log(`❌ [WALLET-PAYMENT:${requestId}] Credito insufficiente. Saldo: ${saldoDisponibile}, Richiesto: ${prezzo}`);
      return res.status(400).json({ 
        error: 'Credito wallet insufficiente', 
        saldo_attuale: saldoDisponibile,
        costo_richiesto: prezzo 
      });
    }

    // 2. Scala il saldo totale dalla tabella utente
    await client.query(
      'UPDATE utente SET saldo_wallet = saldo_wallet - $1 WHERE id = $2',
      [prezzo, clienteId]
    );

    // 3. Registra il movimento in uscita nella tabella transazioni_wallet
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

        // Nota: Qui salviamo lo stato direttamente come 'confermata' o 'pending_pagato' 
        // poiché il pagamento è andato a buon fine istantaneamente tramite il wallet.
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
            `wallet_${transazioneWalletId}`, // Usiamo un riferimento fittizio per tracciabilità
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