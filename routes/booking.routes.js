import { cercaSlotUltra } from '../services/search/search.service.js';
import express from 'express';
import Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';
import { upsertPrenotazione } from '../services/search/search.cache.js';
import { notifyUser } from '../services/notifications/notification.service.js';
import { isPopbusSlot, validatePixelStops } from '../services/pixel/pixel.validation.service.js'; 

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

// ======================= ROUTE =======================
router.post('/payment-intent', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  const requestId = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 60000).toISOString(); 

  console.log(`💳 [PAYMENT:${requestId}] Inizio flusso per user: ${req.user.id}`);
  console.log(`📥 [PAYMENT:${requestId}] Payload ricevuto:`, JSON.stringify(req.body, null, 2));

  let paymentIntent=null;
  let transaction=false;
  let committed=false;
  try {
    const { type, prezzo, slots, usaWallet, searchOrigine, searchDestinazione } = req.body;

    if (!Number.isFinite(Number(prezzo)) || Number(prezzo) <= 0 || Math.round(Number(prezzo) * 100) < 50) {
      console.warn(`⚠️ [PAYMENT:${requestId}] Prezzo non valido: ${prezzo}`);
      return res.status(400).json({ error: 'Prezzo non valido' });
    }
    if (!Array.isArray(slots) || slots.length !== 1 || !slots[0] || typeof slots[0] !== 'object') {
      console.warn(`⚠️ [PAYMENT:${requestId}] Slots mancanti o non validi`);
      return res.status(400).json({ error: 'Slots mancanti' });
    }

    const selected=slots[0];
    const o=searchOrigine||selected.origine,d=searchDestinazione||selected.destinazione;
    const count=Number(selected.posti_richiesti),when=selected.start_datetime;
    if (!o || !d || ![o.lat, o.lon, d.lat, d.lon].every(v => Number.isFinite(Number(v))) ||
        Math.abs(Number(o.lat)) > 90 || Math.abs(Number(d.lat)) > 90 ||
        Math.abs(Number(o.lon)) > 180 || Math.abs(Number(d.lon)) > 180 ||
        (Number(o.lat) === 0 && Number(o.lon) === 0) || (Number(d.lat) === 0 && Number(d.lon) === 0)) {
      return res.status(400).json({ error: 'Coordinate di ricerca non valide' });
    }
    if(!o||!d||!Number.isInteger(count)||count<=0||!when||!Number.isFinite(new Date(when).getTime())||new Date(when)<=new Date())return res.status(400).json({error:'Coordinate, passeggeri e data futura obbligatori'});
    const fresh=await cercaSlotUltra({coord:o,coordDest:d,posti_richiesti:count,start_datetime:when});
    const quotation=fresh.find(x=>String(x.id)===String(selected.id));
    if(!quotation||Math.round(Number(quotation.prezzo)*100)!==Math.round(Number(prezzo)*100))return res.status(409).json({error:'Prezzo/opzione cambiati: ripetere la ricerca'});
    if(isPopbusSlot(quotation) && quotation.is_pool && !String(selected.id).startsWith('virtual_pop_'))return res.status(409).json({error:'PopBus V2: usare richiesta virtuale o prenotazione su corsa reale'});
    // Mantiene i riferimenti PIXEL del client separati dai dati della quotazione.
    const pixelPayload = {
      origine_nodo_territoriale_id: selected.origine_nodo_territoriale_id,
      destinazione_nodo_territoriale_id: selected.destinazione_nodo_territoriale_id,
      origine_fermata_id: selected.origine_fermata_id,
      destinazione_fermata_id: selected.destinazione_fermata_id,
    };
    Object.assign(selected, quotation, { start_datetime: when, posti_richiesti: count }, pixelPayload);
    // Non permettere che il tipo dichiarato dal client cambi il tipo della quotazione.
    if (isPopbusSlot(selected) !== isPopbusSlot(quotation)) {
      return res.status(409).json({ error: 'Tipo di opzione cambiato: ripetere la ricerca' });
    }
    await client.query('BEGIN');transaction=true;
    await client.query('SELECT id FROM utente WHERE id=$1 FOR UPDATE',[req.user.id]);
    const pixelValidated = isPopbusSlot(selected) ? await validatePixelStops(client, selected, quotation) : null;
    // 🔒 Sanitizzazione sicura del tipo corsa per rispettare il vincolo CHECK ('privata', 'condivisa', 'riempimento')
    const sanitizedType = (type === 'condivisa' || type === 'riempimento') ? type : 'privata';
     // Non permettere di convertire un risultato privato in una nuova condivisa
     // senza un preventivo Modello A calcolato e verificato dal server.
     if (!isPopbusSlot(quotation) && sanitizedType === 'condivisa' &&
         (quotation.tipo !== 'condivisa' || quotation.modello_a !== true)) {
       return res.status(409).json({ error: 'Modello A: opzione condivisa non quotabile; ripetere la ricerca' });
     }
     if (!isPopbusSlot(quotation) && quotation.tipo === 'condivisa' && sanitizedType !== 'condivisa') {
       return res.status(409).json({ error: 'Tipo corsa non coerente con la quotazione condivisa' });
     }

    const clienteId = req.user.id;
    let pagatoConWallet = false;

    // ================= CONTROLLO E GESTIONE WALLET =================
     if (usaWallet && sanitizedType === 'condivisa' && !isPopbusSlot(quotation)) {
       return res.status(409).json({ error: 'Wallet non ancora disponibile per conguagli Modello A; utilizzare Stripe' });
     }
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



    if (!pagatoConWallet) {
      console.log(`💳 [PAYMENT:${requestId}] Creazione Stripe PaymentIntent per importo: €${prezzo}`);
      paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(Number(prezzo) * 100),
        currency: 'eur',
        metadata: { tipo: isPopbusSlot(selected) ? 'popbus' : sanitizedType, clienteId: clienteId.toString(), requestId },
        capture_method: 'manual',
      });
      console.log(`💳 [PAYMENT:${requestId}}] Stripe PaymentIntent creato con ID: ${paymentIntent.id}`);
    }
    
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

    // 🔒 GESTIONE SLOT UNICO E ESTRAZIONE INDIRIZZI (Con supporto a ricerca personalizzata)
    const slot = slots[0];
    
    const finalOrigine = {lat:Number(o.lat),lon:Number(o.lon)};
    const finalDestinazione = {lat:Number(d.lat),lon:Number(d.lon)};

    const origineAddress = slot.origine_address || slot.origineAddress || (finalOrigine?.lat ? `Posizione (${finalOrigine.lat.toFixed(4)}, ${finalOrigine.lon.toFixed(4)})` : 'Partenza');
    const destinazioneAddress = slot.destinazione_address || slot.destinazioneAddress || (finalDestinazione?.lat ? `Destinazione (${finalDestinazione.lat.toFixed(4)}, ${finalDestinazione.lon.toFixed(4)})` : 'Arrivo');

    console.log(`🔍 [PAYMENT:${requestId}] Analisi Slot Unico: ID=${slot.id}, VeicoloID=${slot.veicolo_id}, is_pool=${slot.is_pool}`);

    const isPopBus = isPopbusSlot(slot);

    let savedRow;

    if (isPopBus) {
      console.log(`🗺️ [DEBUG-NODES:${requestId}] Chiamata get_or_create_node con coordinate origine: (${finalOrigine.lat}, ${finalOrigine.lon}) e destinazione: (${finalDestinazione.lat}, ${finalDestinazione.lon})`);

      const nodeRes = await client.query(
        `SELECT get_or_create_node($1, $2) as start, get_or_create_node($3, $4) as end`, 
        [finalOrigine.lat, finalOrigine.lon, finalDestinazione.lat, finalDestinazione.lon]
      );

      console.log(`🗺️ [DEBUG-NODES:${requestId}] Nodi restituiti dal DB -> start_node_id: ${nodeRes.rows[0]?.start}, end_node_id: ${nodeRes.rows[0]?.end}`);

      const result = await client.query(
        `INSERT INTO richieste_pop_bus (
          cliente_id, origine, destinazione, start_datetime, posti_richiesti, stato,
          start_node_id, end_node_id, classe, origine_address, destinazione_address, prezzo, payment_intent_id, request_id,
           origine_nodo_territoriale_id, destinazione_nodo_territoriale_id, origine_fermata_id, destinazione_fermata_id
        )
         VALUES (
          $1,
          ST_SetSRID(ST_MakePoint($2,$3),4326),
          ST_SetSRID(ST_MakePoint($4,$5),4326),
          $6, $7, 'in_attesa', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
        ) RETURNING *`,
        [
          clienteId,
          finalOrigine.lon, finalOrigine.lat,
          finalDestinazione.lon, finalDestinazione.lat,
          slot.start_datetime,
          slot.posti_richiesti || 1,
          nodeRes.rows[0].start,
          nodeRes.rows[0].end,
          slot.classe || 'STANDARD',
          origineAddress,
          destinazioneAddress,
          prezzo,
          pagatoConWallet ? `wallet_${requestId}` : paymentIntent.id,
          requestId,
          pixelValidated.origine_nodo_territoriale_id,
          pixelValidated.destinazione_nodo_territoriale_id,
          pixelValidated.origine_fermata_id,
          pixelValidated.destinazione_fermata_id
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

      // Estrazione offset ed indici polyline dallo slot (con supporto a diverse nomenclature)
      const startOffset = slot.startOffset ?? slot.start_offset ?? null;
      const endOffset = slot.endOffset ?? slot.end_offset ?? null;
      const startIndexPolyline = slot.start_index_polyline ?? slot.startIndexPolyline ?? 0;
      const endIndexPolyline = slot.end_index_polyline ?? slot.endIndexPolyline ?? 100;

      // Estraiamo l'ID della corsa dallo slot se si sta agganciando a una corsa condivisa esistente
      const corsaIdToSave = (slot.id && !isNaN(Number(slot.id))) ? Number(slot.id) : (slot.corsa_id || null);

      console.log(`🚗 [DEBUG-INSERT:${requestId}] Inserimento nella tabella pending per veicolo_id: ${slot.veicolo_id}, corsa_id: ${corsaIdToSave}, start_offset: ${startOffset}, end_offset: ${endOffset}`);

      const result = await client.query(
        `INSERT INTO pending (
          veicolo_id, cliente_id, start_datetime, posti_richiesti, tipo_corsa, prezzo, 
          distanza, durata, expires_at, origine, destinazione, stato, payment_intent_id, request_id,
          origine_address, destinazione_address, corsa_id,
          start_offset, end_offset, start_index_polyline, end_index_polyline
        )
         VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          ST_SetSRID(ST_MakePoint($10,$11),4326),
          ST_SetSRID(ST_MakePoint($12,$13),4326),
          'pending', $14, $15, $16, $17, $18,
          $19, $20, $21, $22
        ) RETURNING *`,
        [
          slot.veicolo_id,
          clienteId,
          slot.start_datetime,
          slot.posti_richiesti || 1,
          sanitizedType,
          prezzo,
          distanza,
          durata,
          expiresAt,
          finalOrigine.lon,
          finalOrigine.lat,
          finalDestinazione.lon,
          finalDestinazione.lat,
          pagatoConWallet ? `wallet_${requestId}` : paymentIntent.id,
          requestId,
          origineAddress,
          destinazioneAddress,
          corsaIdToSave,
          startOffset,
          endOffset,
          startIndexPolyline,
          endIndexPolyline
        ]
      );

      savedRow = result.rows[0];
      console.log(`✅ [DEBUG-INSERT:${requestId}] Inserimento pending completato con ID: ${savedRow.id}`);

      console.log(`📦 [DEBUG-CACHE:${requestId}] Aggiornamento cache prenotazioni per ID: ${savedRow.id}`);
      // Cache dopo COMMIT.
    }
    
    pendingRows.push(savedRow);
    console.log(`📝 [PAYMENT:${requestId}] Record inserito correttamente: ${savedRow.id}`);

    await client.query('COMMIT');committed=true;transaction=false;
    if(!isPopBus){try{await upsertPrenotazione(savedRow);}catch(e){console.error('[CACHE POSTCOMMIT]',e.message);}}
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
          data: { requestId, rowId: savedRow.id, type: sanitizedType, start_datetime: slot.start_datetime }
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
        data: { requestId, rowId: savedRow.id, type: sanitizedType, start_datetime: slot.start_datetime }
      });
      console.log(`✅ [NOTIFY_CLIENT:${requestId}] Notifica cliente inviata.`);
    } catch (notifyErr) {
      console.error(`⚠️ [NOTIFY_CLIENT:${requestId}] Errore durante l'invio della notifica cliente:`, notifyErr);
    }


    console.log(`✅ [PAYMENT:${requestId}] Transazione SQL completata con successo (COMMIT).`);

    res.json({ 
      pagatoConWallet, 
      clientSecret: pagatoConWallet ? null : paymentIntent.client_secret, 
      pending: pendingRows, 
      requestId 
    });

  } catch (err) {
    if(transaction&&!committed){try{await client.query('ROLLBACK');}catch(rollbackError){console.error('[PAYMENT ROLLBACK]',rollbackError);}}
    if(!committed&&paymentIntent){try{await stripe.paymentIntents.cancel(paymentIntent.id);}catch(e){console.error('[PAYMENT CANCEL]',e.message);}}
    console.error(`❌ [PAYMENT:${requestId}] Errore critico intercettato. Rollback eseguito. Dettagli:`, err);
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
    console.log(`🔌 [PAYMENT:${requestId}] Connessione al database rilasciata.`);
  }
});

export default router;