import { cercaSlotUltra } from '../services/search/search.service.js';
import express from 'express';
import Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';
import { upsertPrenotazione } from '../services/search/search.cache.js';
import { notifyUser } from '../services/notifications/notification.service.js';
import { isPopbusSlot, validatePixelStops } from '../services/pixel/pixel.validation.service.js'; 

import { resolveConfirmationDeadline } from '../services/popbus/v2/confirmation-deadline.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });
const sanitizedRequestedType = type => (type === 'condivisa' || type === 'riempimento') ? type : 'privata';

// Punti desiderati: non sostituiscono mai le coordinate usate per il ricalcolo della quotazione.
function puntoDesiderato(raw, fallback, nome) {
  const punto = raw ?? fallback;
  const lat = Number(punto?.lat);
  const lon = Number(punto?.lon);
  if (!punto || punto.lat == null || punto.lon == null ||
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) {
    throw Object.assign(new Error(`Coordinate ${nome} non valide`), { status: 400 });
  }
  const indirizzo = typeof punto.address === 'string' ? punto.address.trim() :
    typeof punto.indirizzo === 'string' ? punto.indirizzo.trim() : '';
  if (indirizzo.length > 500) {
    throw Object.assign(new Error(`Indirizzo ${nome} troppo lungo`), { status: 400 });
  }
  return { lat, lon, indirizzo };
}



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
    // La stessa corsa può avere più tratte: l'ID corsa da solo non basta.
    const quotation=fresh.find(x =>
      String(x.id) === String(selected.id) &&
      (x.tipo !== 'condivisa' ||
        (selected.tratta_id != null && String(x.tratta_id) === String(selected.tratta_id)))
    );
    // Il prezzo deve essere quotato dal server: null/undefined/NaN non sono prezzi.
    // Number(null) === 0: non utilizzare conversioni permissive per i pagamenti.
    const prezzoQuotato = quotation?.prezzo;
    const prezzoQuotatoValido = prezzoQuotato !== null && prezzoQuotato !== undefined &&
      prezzoQuotato !== '' && Number.isFinite(Number(prezzoQuotato)) &&
      Math.round(Number(prezzoQuotato) * 100) >= 50;
    if (!quotation || !prezzoQuotatoValido ||
        Math.round(Number(prezzoQuotato) * 100) !== Math.round(Number(prezzo) * 100)) {
      return res.status(409).json({ error: 'Prezzo/opzione cambiati o quotazione assente: ripetere la ricerca' });
    }

    // POPBUS confermata = corsa reale, non nuova richiesta di formazione.
    // Fail-closed: il percorso Booking diretto non e' ancora implementato.
    // Non creare richieste_pop_bus, pending o PaymentIntent per questa corsa.
    const popbusConfermata = isPopbusSlot(quotation) &&
      (quotation.tipo_corsa === 'riempimento' || quotation.attivazione_stato === 'confermata' ||
       (quotation.corsa_id != null && !String(quotation.id).startsWith('virtual_pop_')));
    if (popbusConfermata) {
      console.warn(`[POPBUS BOOKING] Corsa confermata non ancora prenotabile: corsa_id=${quotation.corsa_id ?? quotation.id}`);
      return res.status(409).json({
        error: 'POPBUS confermata: prenotazione diretta non ancora abilitata',
        code: 'POPBUS_ACTIVE_BOOKING_NOT_READY'
      });
    }
    // Conserva il blocco preesistente per ogni POPBUS non virtuale.
    if (isPopbusSlot(quotation) && quotation.is_pool &&
        !String(quotation.id).startsWith('virtual_pop_')) {
      return res.status(409).json({ error: 'POPBUS: opzione non virtuale non prenotabile tramite formazione' });
    }
    // Il cliente non puo' selezionare un ID virtuale e ottenere una corsa reale,
    // o viceversa, riutilizzando dati di ricerca precedenti.
    if (isPopbusSlot(quotation) &&
        String(selected.id).startsWith('virtual_pop_') !== String(quotation.id).startsWith('virtual_pop_')) {
      return res.status(409).json({ error: 'Identita POPBUS cambiata: ripetere la ricerca' });
    }
    // La quotazione fresca prevale su tutti i campi operativi forniti dal client.
    // Nessun ID di fermata o nodo territoriale viene accettato dal client.
    const slot = { ...selected, ...quotation, start_datetime: when, posti_richiesti: count };
    const popbusDeadline = isPopbusSlot(slot) ? resolveConfirmationDeadline(slot.start_datetime, req.body.scadenza_conferma_ore ?? 24) : null;
    // Non permettere che il tipo dichiarato dal client cambi il tipo della quotazione.
    if (isPopbusSlot(slot) !== isPopbusSlot(quotation)) {
      return res.status(409).json({ error: 'Tipo di opzione cambiato: ripetere la ricerca' });
    }
    // Distinzione basata SOLO sulla quotazione fresca, non sul tipo manipolabile dal client.
    const nuovaCondivisibile = !isPopbusSlot(quotation) &&
      sanitizedRequestedType(type) === 'condivisa' &&
      String(quotation.id).startsWith('priv_') && quotation.tipo === 'privata';
    await client.query('BEGIN');transaction=true;
    await client.query('SELECT id FROM utente WHERE id=$1 FOR UPDATE',[req.user.id]);
    const pixelValidated = isPopbusSlot(slot) ? await validatePixelStops(client, slot, quotation) : null;
    // 🔒 Sanitizzazione sicura del tipo corsa per rispettare il vincolo CHECK ('privata', 'condivisa', 'riempimento')
    const sanitizedType = sanitizedRequestedType(type);
     // Non permettere di convertire un risultato privato in una nuova condivisa
     // senza un preventivo Modello A calcolato e verificato dal server.
     if (!isPopbusSlot(quotation) && sanitizedType === 'condivisa' &&
         (!nuovaCondivisibile && (quotation.tipo !== 'condivisa' || quotation.modello_a !== true))) {
       throw Object.assign(new Error('Modello A: opzione condivisa non quotabile; ripetere la ricerca'), { status: 409 });
     }
     if (!isPopbusSlot(quotation) && quotation.tipo === 'condivisa' && sanitizedType !== 'condivisa') {
       throw Object.assign(new Error('Tipo corsa non coerente con la quotazione condivisa'), { status: 409 });
     }

    // Nessun return con transazione aperta: un 409 e' gestito dal catch con ROLLBACK.
    const clienteId = req.user.id;
    let pagatoConWallet = false;

    // ================= CONTROLLO E GESTIONE WALLET =================
     if (usaWallet && sanitizedType === 'condivisa' && !isPopbusSlot(quotation)) {
       throw Object.assign(new Error('Wallet non ancora disponibile per conguagli Modello A; utilizzare Stripe'), { status: 409 });
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
        metadata: { tipo: isPopbusSlot(slot) ? 'popbus' : sanitizedType, clienteId: clienteId.toString(), requestId },
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
    // Compatibilità: in assenza dei punti dettagliati, si utilizzano quelli della ricerca.
    // Il frontend deve inviare origineDesiderata/destinazioneDesiderata per i punti Google Places.
    const origineRichiesta = puntoDesiderato(req.body.origineDesiderata, o, 'origine desiderata');
    const destinazioneRichiesta = puntoDesiderato(req.body.destinazioneDesiderata, d, 'destinazione desiderata');
    const finalOrigine = { lat: origineRichiesta.lat, lon: origineRichiesta.lon };
    const finalDestinazione = { lat: destinazioneRichiesta.lat, lon: destinazioneRichiesta.lon };

    const origineAddress = origineRichiesta.indirizzo || slot.origine_address || slot.origineAddress ||
      `Posizione (${finalOrigine.lat.toFixed(4)}, ${finalOrigine.lon.toFixed(4)})`;
    const destinazioneAddress = destinazioneRichiesta.indirizzo || slot.destinazione_address || slot.destinazioneAddress ||
      `Destinazione (${finalDestinazione.lat.toFixed(4)}, ${finalDestinazione.lon.toFixed(4)})`;

    console.log(`🔍 [PAYMENT:${requestId}] Analisi Slot Unico: ID=${slot.id}, VeicoloID=${slot.veicolo_id}, is_pool=${slot.is_pool}`);

    const isPopBus = isPopbusSlot(slot);

    let savedRow;

    if (isPopBus) {
      // PIXEL e' la fonte autorevole per i nodi territoriali POPBUS.
      // get_or_create_node() non garantisce ID della tabella nodi_territoriali
      // e non deve alimentare le colonne soggette alle relative foreign key.
      const startNodeId = Number(pixelValidated?.origine_nodo_territoriale_id);
      const endNodeId = Number(pixelValidated?.destinazione_nodo_territoriale_id);
      if (!Number.isSafeInteger(startNodeId) || startNodeId <= 0 ||
          !Number.isSafeInteger(endNodeId) || endNodeId <= 0 ||
          startNodeId === endNodeId) {
        throw Object.assign(new Error('Nodi territoriali PIXEL non validi'), { status: 409 });
      }
      console.log(`[PIXEL-NODES:${requestId}] Nodi territoriali validati: ${startNodeId} -> ${endNodeId}`);

      const result = await client.query(
        `INSERT INTO richieste_pop_bus (
          cliente_id, origine, destinazione, start_datetime, posti_richiesti, stato,
          start_node_id, end_node_id, classe, origine_address, destinazione_address, prezzo, payment_intent_id, request_id,
           origine_nodo_territoriale_id, destinazione_nodo_territoriale_id, origine_fermata_id, destinazione_fermata_id, scadenza_conferma_ore, conferma_entro
        )
         VALUES (
          $1,
          ST_SetSRID(ST_MakePoint($2,$3),4326),
          ST_SetSRID(ST_MakePoint($4,$5),4326),
          $6, $7, 'in_attesa', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
        ) RETURNING *`,
        [
          clienteId,
          finalOrigine.lon, finalOrigine.lat,
          finalDestinazione.lon, finalDestinazione.lat,
          slot.start_datetime,
          slot.posti_richiesti || 1,
          startNodeId,
          endNodeId,
          slot.classe || 'STANDARD',
          origineAddress,
          destinazioneAddress,
          prezzo,
          pagatoConWallet ? `wallet_${requestId}` : paymentIntent.id,
          requestId,
          pixelValidated.origine_nodo_territoriale_id,
          pixelValidated.destinazione_nodo_territoriale_id,
          null, // fermata salita assegnata successivamente da POPBUS V2
          null, // fermata discesa assegnata successivamente da POPBUS V2
          popbusDeadline.hours,
          popbusDeadline.deadline
        ]
      );

      savedRow = result.rows[0];
      console.log(`✅ [DEBUG-INSERT:${requestId}] Inserimento richieste_pop_bus completato con ID: ${savedRow.id}`);

    } else {
      if (slot.veicolo_id === undefined || slot.veicolo_id === null) {
        console.error(`🚨 [PAYMENT:${requestId}] ERRORE CRITICO: Lo slot ${slot.id} non ha veicolo_id!`);
        throw new Error(`Dato corrotto: veicolo_id mancante per lo slot ${slot.id}`);
      }

      // Unita' canoniche: distanza in km, durata in minuti. Dati dalla quotazione server.
      const distanza = Number(quotation.distanzaKm ??
        (quotation.distanza_metri != null ? Number(quotation.distanza_metri) / 1000 : quotation.distanza));
      const durata = Number(quotation.durata_minuti ?? quotation.durataMinuti);
      if (!Number.isFinite(distanza) || distanza <= 0 || !Number.isFinite(durata) || durata <= 0) {
        throw Object.assign(new Error('Distanza/durata non quotate dal server'), { status: 409 });
      }

      // Estrazione offset ed indici polyline dallo slot (con supporto a diverse nomenclature)
      const startOffset = slot.startOffset ?? slot.start_offset ?? null;
      const endOffset = slot.endOffset ?? slot.end_offset ?? null;
      const startIndexPolyline = slot.start_index_polyline ?? slot.startIndexPolyline ?? 0;
      const endIndexPolyline = slot.end_index_polyline ?? slot.endIndexPolyline ?? 100;

      // Estraiamo l'ID della corsa dallo slot se si sta agganciando a una corsa condivisa esistente
      const corsaIdToSave = nuovaCondivisibile || quotation.tipo === 'privata'
        ? null : Number(quotation.corsa_id ?? quotation.id);
      if (sanitizedType === 'condivisa' && !nuovaCondivisibile &&
          (!Number.isSafeInteger(corsaIdToSave) || corsaIdToSave <= 0)) {
        throw Object.assign(new Error('Corsa condivisa senza ID valido'), { status: 409 });
      }

      // Identità della tratta ricavata dalla quotazione fresca, mai dal payload client.
      let trattaIdToSave = null;
      if (sanitizedType === 'condivisa' && !nuovaCondivisibile) {
        trattaIdToSave = Number(quotation.tratta_id);
        if (!Number.isSafeInteger(trattaIdToSave) || trattaIdToSave <= 0) {
          throw Object.assign(new Error('Tratta NCC non disponibile: ripetere la ricerca'), { status: 409 });
        }
        const verificaTratta = await client.query(`
          SELECT t.id, t.direzione, t.stato_temporale, t.partenza_prevista
          FROM public.corse_tratte t
          JOIN public.corse c ON c.id = t.corsa_id
          WHERE t.id = $1 AND t.corsa_id = $2
            AND c.veicolo_id = $3
            AND c.tipo_corsa = 'condivisa'
            AND c.stato = 'prenotabile'
            AND (
               (t.stato_temporale = 'programmato' AND t.partenza_prevista IS NOT NULL)
               OR (t.direzione = 'ritorno' AND t.stato_temporale = 'flessibile'
                  AND t.partenza_prevista IS NULL AND t.prima_prenotazione_id IS NULL)
             )
          FOR SHARE OF t, c
        `, [trattaIdToSave, corsaIdToSave, slot.veicolo_id]);
        // Diagnostica di sola lettura: identifica quale condizione genera il 409 NCC.
        console.log('[NCC PAYMENT VALIDATION]', JSON.stringify({
          requestId,
          corsaIdToSave,
          trattaIdToSave,
          veicoloId: slot.veicolo_id,
          quotation_stato_temporale: quotation.stato_temporale ?? null,
          quotation_stato_temporale_presente: Object.prototype.hasOwnProperty.call(quotation, 'stato_temporale'),
          quotation_tratta_id: quotation.tratta_id ?? null,
          rowCount: verificaTratta.rowCount,
          db_stato_temporale: verificaTratta.rows[0]?.stato_temporale ?? null,
          db_direzione: verificaTratta.rows[0]?.direzione ?? null,
          db_partenza_prevista: verificaTratta.rows[0]?.partenza_prevista ?? null,
          motivo_potenziale: verificaTratta.rowCount !== 1
            ? 'QUERY_NON_RESTITUISCE_UNA_RIGA'
            : ((quotation.stato_temporale === 'flessibile') !==
               (verificaTratta.rows[0].stato_temporale === 'flessibile'))
              ? 'STATO_TEMPORALE_NON_COINCIDE'
              : 'VALIDAZIONE_OK'
        }));
        // La query SQL verifica lo stato reale della tratta sotto lock.
        // Una quotazione priva di stato_temporale non deve essere interpretata
        // come "programmato" e causare un falso conflitto sul ritorno flessibile.
        if (verificaTratta.rowCount !== 1) {
          throw Object.assign(new Error('Tratta NCC non più disponibile: ripetere la ricerca'), { status: 409 });
        }
        const statoTemporaleDB = verificaTratta.rows[0].stato_temporale;
        const statoTemporaleQuotazione = quotation.stato_temporale;
        if (statoTemporaleQuotazione != null && statoTemporaleQuotazione !== statoTemporaleDB) {
          throw Object.assign(new Error('Stato temporale NCC cambiato: ripetere la ricerca'), { status: 409 });
        }
        if (![startOffset, endOffset].every(v => v != null && Number.isFinite(Number(v))) ||
            Number(startOffset) < 0 || Number(endOffset) <= Number(startOffset)) {
          throw Object.assign(new Error('Intervallo tratta non valido: ripetere la ricerca'), { status: 409 });
        }
      }

      console.log(`🚗 [DEBUG-INSERT:${requestId}] Inserimento nella tabella pending per veicolo_id: ${slot.veicolo_id}, corsa_id: ${corsaIdToSave}, start_offset: ${startOffset}, end_offset: ${endOffset}`);

      const result = await client.query(
        `INSERT INTO pending (
          veicolo_id, cliente_id, start_datetime, posti_richiesti, tipo_corsa, prezzo, 
          distanza, durata, expires_at, origine, destinazione, stato, payment_intent_id, request_id,
          origine_address, destinazione_address, corsa_id,
          start_offset, end_offset, start_index_polyline, end_index_polyline, tratta_id
        )
         VALUES (
          $1, $2, $3, $4, $5, $6, $7, ($8::numeric * INTERVAL '1 minute'), $9,
          ST_SetSRID(ST_MakePoint($10,$11),4326),
          ST_SetSRID(ST_MakePoint($12,$13),4326),
          'pending', $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23
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
          endIndexPolyline,
          trattaIdToSave
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


// ==============================================================
// A/R STEP 2 — PREVIEW DI SOLA LETTURA, SENZA PREAUTORIZZAZIONI
// L'endpoint singolo /payment-intent rimane invariato.
// POST /api/booking/ar/preview
// Body: { tratte: [{ ar_tratta:'andata', slot:{...}, type:'privata'|'condivisa'|'popbus' },
//                 { ar_tratta:'ritorno', slot:{...}, type:'...' }] }
// NON costituisce una prenotazione né una garanzia di disponibilità.
// ==============================================================
router.post('/ar/preview', authMiddleware, async (req, res) => {
  const tratte = req.body?.tratte;
  if (!Array.isArray(tratte) || tratte.length !== 2 ||
      tratte[0]?.ar_tratta !== 'andata' || tratte[1]?.ar_tratta !== 'ritorno') {
    return res.status(400).json({ code: 'AR_INVALID_LEGS', error: 'Servono andata e ritorno, in quest’ordine' });
  }
  const result = [];
  try {
    for (const item of tratte) {
      const selected = item?.slot;
      if (!selected || typeof selected !== 'object') {
        return res.status(400).json({ code: 'AR_INVALID_SLOT', error: `Slot ${item.ar_tratta} mancante` });
      }
      const o = selected.origine;
      const d = selected.destinazione;
      // Non usare coordinate globali di ricerca: il ritorno ha origine/destinazione proprie.
      const origine = puntoDesiderato(o, null, `${item.ar_tratta} origine`);
      const destinazione = puntoDesiderato(d, null, `${item.ar_tratta} destinazione`);
      const count = Number(selected.posti_richiesti);
      const when = selected.start_datetime;
      if (!Number.isSafeInteger(count) || count <= 0 ||
          !when || !Number.isFinite(new Date(when).getTime()) || new Date(when).getTime() <= Date.now()) {
        return res.status(400).json({ code: 'AR_INVALID_DATE_SEATS', error: `Data o passeggeri ${item.ar_tratta} non validi` });
      }
      const fresh = await cercaSlotUltra({
        coord: { lat: origine.lat, lon: origine.lon },
        coordDest: { lat: destinazione.lat, lon: destinazione.lon },
        posti_richiesti: count,
        start_datetime: when
      });
      const quote = fresh.find(x =>
        String(x.id) === String(selected.id) &&
        (x.tipo !== 'condivisa' ||
          (selected.tratta_id != null && String(x.tratta_id) === String(selected.tratta_id)))
      );
      if (!quote || quote.prezzo == null || quote.prezzo === '' ||
          !Number.isFinite(Number(quote.prezzo)) || Math.round(Number(quote.prezzo) * 100) < 50) {
        return res.status(409).json({ code: 'AR_QUOTE_CHANGED', error: `Quotazione ${item.ar_tratta} non disponibile: ripetere la ricerca` });
      }
      const isPop = isPopbusSlot(quote);
      const activePop = isPop && (quote.tipo_corsa === 'riempimento' ||
        quote.attivazione_stato === 'confermata' ||
        (quote.corsa_id != null && !String(quote.id).startsWith('virtual_pop_')));
      if (activePop || (isPop && quote.is_pool && !String(quote.id).startsWith('virtual_pop_'))) {
        return res.status(409).json({ code: 'POPBUS_ACTIVE_BOOKING_NOT_READY', error: `PopBus ${item.ar_tratta} già attivo: prenotazione diretta non disponibile` });
      }
      if (isPop && String(selected.id).startsWith('virtual_pop_') !== String(quote.id).startsWith('virtual_pop_')) {
        return res.status(409).json({ code: 'AR_POPBUS_ID_CHANGED', error: `Identità PopBus ${item.ar_tratta} cambiata` });
      }
      if (item.type !== 'privata' && item.type !== 'condivisa' && item.type !== 'popbus') {
        return res.status(400).json({ code: 'AR_INVALID_TYPE', error: `Tipo ${item.ar_tratta} non valido` });
      }
      if (isPop !== (item.type === 'popbus')) {
        return res.status(409).json({ code: 'AR_TYPE_CHANGED', error: `Tipo ${item.ar_tratta} non coerente con la quotazione` });
      }
      if (!isPop && item.type === 'condivisa' &&
          !(quote.tipo === 'condivisa' && quote.modello_a === true)) {
        // La conversione da privata a condivisa richiede la verifica Modello A
        // che verrà gestita dal coordinatore; non dichiararla disponibile qui.
        return res.status(409).json({ code: 'AR_MODEL_A_NOT_VERIFIED', error: `Modello A ${item.ar_tratta} non verificato` });
      }
      if (!isPop && item.type === 'privata' && quote.tipo !== 'privata') {
        return res.status(409).json({ code: 'AR_TYPE_CHANGED', error: `Opzione ${item.ar_tratta} non privata` });
      }
      result.push({
        ar_tratta: item.ar_tratta,
        tipo: item.type,
        id: String(quote.id),
        tratta_id: quote.tratta_id ?? null,
        prezzo: Number((Math.round(Number(quote.prezzo) * 100) / 100).toFixed(2)),
        posti_richiesti: count,
        start_datetime: when
      });
    }
    if (new Date(result[1].start_datetime).getTime() <= new Date(result[0].start_datetime).getTime()) {
      return res.status(400).json({ code: 'AR_INVALID_ORDER', error: 'Il ritorno deve essere successivo all’andata' });
    }
    const totaleCentesimi = result.reduce((sum, r) => sum + Math.round(r.prezzo * 100), 0);
    return res.json({
      stato: 'preview_non_prenotabile',
      pagamento_abilitato: false,
      tratte: result,
      prezzo_totale: totaleCentesimi / 100,
      messaggio: 'Preventivo indicativo ricalcolato: nessuna richiesta o autorizzazione Stripe creata'
    });
  } catch (err) {
    console.error('[AR PREVIEW]', err);
    return res.status(err.status || 500).json({ code: 'AR_PREVIEW_ERROR', error: err.status ? err.message : 'Errore nel ricalcolo A/R' });
  }
});


// A/R NCC STEP 4: preparazione atomica dei due pending e due PI manuali.
// Il checkout A/R non abilita accettazione o cattura individuale.
router.post('/ar/payment-intents', authMiddleware, async (req, res) => {
  const tratte = req.body?.tratte;
  if (!Array.isArray(tratte) || tratte.length !== 2 ||
      tratte[0]?.ar_tratta !== 'andata' || tratte[1]?.ar_tratta !== 'ritorno') {
    return res.status(400).json({ code: 'AR_INVALID_LEGS', error: 'Servono andata e ritorno in ordine' });
  }
  if (req.body?.usaWallet) {
    return res.status(409).json({ code: 'AR_WALLET_NOT_READY', error: 'Wallet A/R non abilitato' });
  }

  const groupId = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
  const intents = [];
  let client;
  let transaction = false;
  let committed = false;
  try {
    // Nessun lock DB durante il ricalcolo della ricerca.
    const prepared = [];
    for (const item of tratte) {
      const selected = item?.slot;
      if (!selected || typeof selected !== 'object' || item.type !== 'privata') {
        throw Object.assign(new Error('Checkout A/R: in questa fase solo NCC privata'), { status: 409, code: 'AR_TYPE_NOT_READY' });
      }
      const o = puntoDesiderato(selected.origine, null, 'origine');
      const d = puntoDesiderato(selected.destinazione, null, 'destinazione');
      const count = Number(selected.posti_richiesti);
      const when = selected.start_datetime;
      if (!Number.isSafeInteger(count) || count <= 0 ||
          !Number.isFinite(new Date(when).getTime()) || new Date(when).getTime() <= Date.now()) {
        throw Object.assign(new Error('Data o posti non validi'), { status: 400 });
      }
      const fresh = await cercaSlotUltra({
        coord: { lat: o.lat, lon: o.lon },
        coordDest: { lat: d.lat, lon: d.lon },
        posti_richiesti: count,
        start_datetime: when
      });
      const quote = fresh.find(x => String(x.id) === String(selected.id));
      if (!quote || isPopbusSlot(quote) || quote.tipo !== 'privata' ||
          !String(quote.id).startsWith('priv_')) {
        throw Object.assign(new Error('Opzione NCC privata non più disponibile'), { status: 409 });
      }
      const cents = Math.round(Number(quote.prezzo) * 100);
      if (quote.prezzo == null || quote.prezzo === '' || !Number.isSafeInteger(cents) || cents < 50) {
        throw Object.assign(new Error('Prezzo non quotato dal server'), { status: 409 });
      }
      const distanza = Number(quote.distanzaKm ??
        (quote.distanza_metri != null ? Number(quote.distanza_metri) / 1000 : quote.distanza));
      const durata = Number(quote.durata_minuti ?? quote.durataMinuti);
      if (!Number.isFinite(distanza) || distanza <= 0 || !Number.isFinite(durata) || durata <= 0 ||
          !Number.isSafeInteger(Number(quote.veicolo_id)) || Number(quote.veicolo_id) <= 0) {
        throw Object.assign(new Error('Veicolo, distanza o durata non validi'), { status: 409 });
      }
      prepared.push({ item, quote, o, d, count, when, cents, distanza, durata });
    }
    if (new Date(prepared[1].when).getTime() <= new Date(prepared[0].when).getTime()) {
      throw Object.assign(new Error('Il ritorno deve seguire l’andata'), { status: 400 });
    }

    client = await pool.connect();
    await client.query('BEGIN');
    transaction = true;
    const owner = await client.query('SELECT id FROM utente WHERE id=$1 FOR UPDATE', [req.user.id]);
    if (owner.rowCount !== 1) throw Object.assign(new Error('Cliente non trovato'), { status: 404 });
    await client.query(
      `INSERT INTO public.ar_gruppi (id, cliente_id, stato, expires_at)
       VALUES ($1, $2, 'preparazione', $3)`,
      [groupId, req.user.id, expiresAt]
    );

    const rows = [];
    for (const leg of prepared) {
      const requestId = uuidv4();
      const intent = await stripe.paymentIntents.create({
        amount: leg.cents,
        currency: 'eur',
        capture_method: 'manual',
        metadata: {
          tipo: 'privata', clienteId: String(req.user.id), requestId,
          ar_group_id: groupId, ar_tratta: leg.item.ar_tratta, ar_vincolata: 'true'
        }
      }, { idempotencyKey: `turentu-ar-${groupId}-${leg.item.ar_tratta}` });
      intents.push(intent);
      const startOffset = leg.quote.startOffset ?? leg.quote.start_offset ?? null;
      const endOffset = leg.quote.endOffset ?? leg.quote.end_offset ?? null;
      const startIndex = leg.quote.start_index_polyline ?? leg.quote.startIndexPolyline ?? 0;
      const endIndex = leg.quote.end_index_polyline ?? leg.quote.endIndexPolyline ?? 100;
      const origineAddress = leg.o.indirizzo || leg.quote.origine_address || leg.quote.origineAddress ||
        `Posizione (${leg.o.lat.toFixed(4)}, ${leg.o.lon.toFixed(4)})`;
      const destinazioneAddress = leg.d.indirizzo || leg.quote.destinazione_address || leg.quote.destinazioneAddress ||
        `Destinazione (${leg.d.lat.toFixed(4)}, ${leg.d.lon.toFixed(4)})`;
      const inserted = await client.query(
        `INSERT INTO pending (
           veicolo_id, cliente_id, start_datetime, posti_richiesti, tipo_corsa, prezzo,
           distanza, durata, expires_at, origine, destinazione, stato, payment_intent_id,
           request_id, origine_address, destinazione_address, corsa_id,
           start_offset, end_offset, start_index_polyline, end_index_polyline, tratta_id,
           ar_group_id, ar_tratta, ar_vincolata
         ) VALUES (
           $1,$2,$3,$4,'privata',$5,$6,($7::numeric * INTERVAL '1 minute'),$8,
           ST_SetSRID(ST_MakePoint($9,$10),4326),
           ST_SetSRID(ST_MakePoint($11,$12),4326),
           'pending',$13,$14,$15,$16,NULL,$17,$18,$19,$20,NULL,$21,$22,TRUE
         ) RETURNING id`,
        [Number(leg.quote.veicolo_id), req.user.id, leg.when, leg.count,
         leg.cents / 100, leg.distanza, leg.durata, expiresAt,
         leg.o.lon, leg.o.lat, leg.d.lon, leg.d.lat, intent.id, requestId,
         origineAddress, destinazioneAddress, startOffset, endOffset,
         startIndex, endIndex, groupId, leg.item.ar_tratta]
      );
      rows.push({ ar_tratta: leg.item.ar_tratta, pending_id: inserted.rows[0].id,
        requestId, prezzo: leg.cents / 100, clientSecret: intent.client_secret });
    }
    const { transitionArGroup } = await import('../services/booking/ar-coordinator.service.js');
    await transitionArGroup(client, groupId, 'preparazione', 'in_autorizzazione', req.user.id);
    await client.query('COMMIT');
    committed = true;
    transaction = false;
    return res.json({ ar_group_id: groupId, stato: 'in_autorizzazione',
      expires_at: expiresAt, tratte: rows,
      confermata: false, cattura_abilitata: false });
  } catch (err) {
    if (transaction && client) {
      try { await client.query('ROLLBACK'); } catch (e) { console.error('[AR ROLLBACK]', e); }
    }
    if (!committed) {
      for (const intent of intents) {
        try { await stripe.paymentIntents.cancel(intent.id); }
        catch (e) { console.error('[AR STRIPE COMPENSATION]', intent.id, e.message); }
      }
    }
    console.error('[AR PAYMENT-INTENTS]', groupId, err);
    return res.status(err.status || 500).json({ code: err.code || 'AR_CHECKOUT_ERROR',
      error: err.status ? err.message : 'Checkout A/R non riuscito' });
  } finally {
    if (client) client.release();
  }
});

// Verifica esplicita: non modifica prenotazioni o cattura fondi.
router.post('/ar/:groupId/verify-authorization', authMiddleware, async (req, res) => {
  const groupId = req.params.groupId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(groupId)) {
    return res.status(400).json({ code: 'AR_INVALID_GROUP' });
  }
  let client;
  let transaction = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN'); transaction = true;
    const { getArGroupForUpdate, transitionArGroup } =
      await import('../services/booking/ar-coordinator.service.js');
    const group = await getArGroupForUpdate(client, groupId, req.user.id);
    if (group.stato === 'autorizzato') {
      await client.query('COMMIT'); transaction = false;
      return res.json({ ar_group_id: groupId, stato: 'autorizzato', confermata: false });
    }
    if (group.stato !== 'in_autorizzazione' || new Date(group.expires_at).getTime() <= Date.now()) {
      throw Object.assign(new Error('Gruppo A/R non autorizzabile o scaduto'), { status: 409 });
    }
    const result = await client.query(
      `SELECT ar_tratta, payment_intent_id, prezzo FROM public.pending
       WHERE ar_group_id=$1 AND cliente_id=$2 AND ar_vincolata=TRUE FOR UPDATE`,
      [groupId, req.user.id]
    );
    const legs = result.rows;
    if (legs.length !== 2 || legs[0].ar_tratta === legs[1].ar_tratta ||
        !legs.some(x => x.ar_tratta === 'andata') || !legs.some(x => x.ar_tratta === 'ritorno')) {
      throw Object.assign(new Error('Coppia A/R incompleta'), { status: 409 });
    }
    const statuses = [];
    for (const leg of legs) {
      const intent = await stripe.paymentIntents.retrieve(leg.payment_intent_id);
      const cents = Math.round(Number(leg.prezzo) * 100);
      const valid = intent.status === 'requires_capture' && intent.capture_method === 'manual' &&
        intent.currency === 'eur' && intent.amount_capturable >= cents &&
        intent.amount === cents && intent.metadata?.ar_group_id === groupId &&
        intent.metadata?.ar_tratta === leg.ar_tratta &&
        intent.metadata?.clienteId === String(req.user.id);
      statuses.push({ ar_tratta: leg.ar_tratta, autorizzata: valid });
    }
    if (statuses.every(x => x.autorizzata)) {
      await transitionArGroup(client, groupId, 'in_autorizzazione', 'autorizzato', req.user.id);
    }
    await client.query('COMMIT'); transaction = false;
    return res.json({ ar_group_id: groupId,
      stato: statuses.every(x => x.autorizzata) ? 'autorizzato' : 'in_autorizzazione',
      tratte: statuses, confermata: false, cattura_abilitata: false });
  } catch (err) {
    if (transaction && client) {
      try { await client.query('ROLLBACK'); } catch (e) { console.error('[AR VERIFY ROLLBACK]', e); }
    }
    console.error('[AR VERIFY]', groupId, err);
    return res.status(err.status || 500).json({ code: 'AR_VERIFY_ERROR',
      error: err.status ? err.message : 'Verifica autorizzazioni non riuscita' });
  } finally { if (client) client.release(); }
});

// Diagnostica NCC A/R: NON persiste accettazioni e NON conferma corse.
// Non utilizzare questa rotta come accettazione operativa in produzione.
router.post('/ar/:groupId/accept', authMiddleware, async (req, res) => {
  const groupId = req.params.groupId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(groupId)) {
    return res.status(400).json({ code: 'AR_INVALID_GROUP' });
  }
  const operatoreId = Number(req.user?.id);
  if (!Number.isSafeInteger(operatoreId) || operatoreId <= 0) {
    return res.status(403).json({ code: 'AR_OPERATOR_UNAUTHORIZED' });
  }
  try {
    const { coordinaAccettazioneProvvisoriaNccAR } =
      await import('../services/booking/ar-ncc-acceptance-coordinator.service.js');
    const risultato = await coordinaAccettazioneProvvisoriaNccAR({
      arGroupId: groupId,
      operatoreId,
      rollbackOnly: true
    });
    return res.json({
      ...risultato,
      diagnostica: true,
      rollbackOnly: true,
      statoPersistito: false,
      confermata: false,
      catturaStripeAbilitata: false
    });
  } catch (err) {
    console.error('[AR NCC ACCEPT DIAGNOSTIC]', groupId, err);
    return res.status(409).json({
      code: 'AR_NCC_ACCEPT_DIAGNOSTIC_FAILED',
      diagnostica: true,
      rollbackOnly: true,
      statoPersistito: false,
      confermata: false,
      catturaStripeAbilitata: false
    });
  }
});

export default router;