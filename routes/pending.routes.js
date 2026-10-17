import express from 'express';
import Stripe from 'stripe';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getIO } from '../socket.js';
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';
import { createCorsaFromPending } from '../services/corsa/corsa.service.js';
import { upsertCorsa } from '../services/search/search.cache.js';
import { CacheManager } from '../utils/cacheManager.js';
import { notifyUser } from '../services/notifications/notification.service.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();
router.use(authMiddleware);

router.get('/autista/:veicolo_id', async (req, res) => {
    const client = await pool.connect();
    try {
        const { veicolo_id } = req.params;
        const result = await client.query(
            `SELECT 
                id, veicolo_id, cliente_id, start_datetime, durata, posti_richiesti, tipo_corsa, created_at, expires_at, stato, 
                COALESCE(prezzo, 0)::float AS prezzo,
                posti_totali, posti_disponibili, payment_intent_id, request_id, corsa_id, distanza,
                CASE 
                    WHEN origine_address IS NULL OR origine_address LIKE '%POINT%' OR origine_address LIKE '%(%' OR origine_address = '' 
                    THEN 'Punto di partenza' 
                    ELSE origine_address 
                END AS origine_address,
                CASE 
                    WHEN destinazione_address IS NULL OR destinazione_address LIKE '%POINT%' OR destinazione_address LIKE '%(%' OR destinazione_address = '' 
                    THEN 'Destinazione' 
                    ELSE destinazione_address 
                END AS destinazione_address
               FROM pending 
               WHERE veicolo_id = $1 AND stato = 'pending'`,
            [veicolo_id]
        );
        res.json({ pendings: result.rows });
    } catch (err) {
        console.error("❌ Errore in GET /api/pending/autista/:id:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.post('/:id/accetta', async (req, res) => {
  const client = await pool.connect();
  const notificheDaInviare = [];
  const id = Number(req.params.id);

  console.log(`🔍 [ACCETTA] Ricevuta richiesta per accettare il pending ID: ${id}`);

  let committed=false;
  try {
    await client.query('BEGIN');

    const pendingRes = await client.query(`
        SELECT *, 
          CASE 
            WHEN origine_address IS NULL OR origine_address LIKE '%POINT%' OR origine_address LIKE '%(%' OR origine_address = 'N/D' OR origine_address = '' 
            THEN 'Punto di partenza' 
            ELSE origine_address 
          END AS origine_address,
          CASE 
            WHEN destinazione_address IS NULL OR destinazione_address LIKE '%POINT%' OR destinazione_address LIKE '%(%' OR destinazione_address = 'N/D' OR destinazione_address = '' 
            THEN 'Destinazione' 
            ELSE destinazione_address 
          END AS destinazione_address
        FROM pending 
        WHERE id = $1 FOR UPDATE
    `, [id]);

    if (!pendingRes.rows.length) {
      console.warn(`⚠️ [ACCETTA] Pending ID ${id} non trovato nel database.`);
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pending non trovato' });
    }

    const p = pendingRes.rows[0];
    console.log(`📋 [ACCETTA] Dati pending trovati:`, { id: p.id, stato: p.stato, veicolo_id: p.veicolo_id, cliente_id: p.cliente_id, tipo_corsa: p.tipo_corsa, corsa_id: p.corsa_id });

    const {rows:owner}=await client.query('SELECT driver_id FROM veicolo WHERE id=$1',[p.veicolo_id]);
    if(!owner.length||Number(owner[0].driver_id)!==Number(req.user.id)){
      await client.query('ROLLBACK');return res.status(403).json({error:'Veicolo non tuo'});
    }
    if(!p.expires_at||new Date(p.expires_at)<=new Date()){
      await client.query('ROLLBACK');return res.status(409).json({error:'Richiesta scaduta'});
    }
    if (p.stato !== 'pending') {
      console.warn(`⚠️ [ACCETTA] Tentativo di accettare un pending con stato non valido ('${p.stato}'). Richiesto 'pending'.`);
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Non disponibile (stato non valido)' });
    }

    const result = await client.query(
      `UPDATE pending SET stato = 'accettata' WHERE id = $1 
       RETURNING *, ST_X(origine::geometry) AS origine_lon, ST_Y(origine::geometry) AS origine_lat,
       ST_X(destinazione::geometry) AS destinazione_lon, ST_Y(destinazione::geometry) AS destinazione_lat,
       start_offset, end_offset`,
      [id]
    );

    for (const pRow of result.rows) {
      pRow.origine_address = p.origine_address;
      pRow.destinazione_address = p.destinazione_address;

      const driverRes = await client.query(
        `SELECT v.driver_id, u.nome AS driver_nome FROM veicolo v 
         JOIN utente u ON u.id = v.driver_id WHERE v.id = $1`, [pRow.veicolo_id]
      );

      const driverId = driverRes.rows[0]?.driver_id ?? req.user?.id;
      const driverNome = driverRes.rows[0]?.driver_nome ?? 'Autista N/D';
      
      const isPopBus = (pRow.tipo_corsa === 'popbus' || pRow.direttrice_id != null);

      console.log(`🚗 [ACCETTA] Analisi tipologia corsa -> isPopBus: ${isPopBus}, corsa_id presente: ${!!pRow.corsa_id}`);

      // AGGIORNATO: Inclusi start_offset ed end_offset per evitare offset a zero o NaN
      const segmenti = { 
          startIdx: pRow.start_index_polyline == null ? NaN : Number(pRow.start_index_polyline),
          endIdx: pRow.end_index_polyline == null ? NaN : Number(pRow.end_index_polyline),
          start_offset: pRow.start_offset == null ? NaN : Number(pRow.start_offset),
          end_offset: pRow.end_offset == null ? NaN : Number(pRow.end_offset),
          latSalita: Number(pRow.origine_lat),
          lonSalita: Number(pRow.origine_lon),
          latDiscesa: Number(pRow.destinazione_lat),
          lonDiscesa: Number(pRow.destinazione_lon)
      };

      let corsa;
      let prenotazioneEffettuata = false;

      // Ignoriamo il corsa_id se corrisponde al veicolo_id (evitando il falso ID veicolo scambiato per corsa)
      const validCorsaId = pRow.corsa_id ?? null;
      const isNccCondivisa = !isPopBus && pRow.tipo_corsa === 'condivisa';
      // Una condivisa NCC deve agganciarsi esclusivamente a una corsa esistente.
      if (isNccCondivisa && (!Number.isSafeInteger(Number(validCorsaId)) || Number(validCorsaId) <= 0)) {
        const error = new Error('Corsa condivisa non associata: ripetere la ricerca');
        error.code = 'NCC_SHARED_COURSE_UNAVAILABLE';
        throw error;
      }

      // Fail-closed: gli offset devono provenire dal matching reale, non da default.
      // Non si presume che una corsa sia compatibile solo perche' l'ID esiste.
      if (isNccCondivisa && (
        !Number.isSafeInteger(segmenti.startIdx) || segmenti.startIdx < 0 ||
        !Number.isSafeInteger(segmenti.endIdx) || segmenti.endIdx <= segmenti.startIdx ||
        !Number.isFinite(segmenti.start_offset) || segmenti.start_offset < 0 ||
        !Number.isFinite(segmenti.end_offset) || segmenti.end_offset <= segmenti.start_offset ||
        !Number.isFinite(segmenti.latSalita) || !Number.isFinite(segmenti.lonSalita) ||
        !Number.isFinite(segmenti.latDiscesa) || !Number.isFinite(segmenti.lonDiscesa) ||
        Math.abs(segmenti.latSalita) > 90 || Math.abs(segmenti.latDiscesa) > 90 ||
        Math.abs(segmenti.lonSalita) > 180 || Math.abs(segmenti.lonDiscesa) > 180
      )) {
        const error = new Error('Dati di aggancio alla condivisa mancanti o non validi: ripetere la ricerca');
        error.code = 'NCC_SHARED_COURSE_UNAVAILABLE';
        throw error;
      }

      if (validCorsaId) {
        console.log(`🔍 [ACCETTA] Verifica esistenza corsa associata ID: ${validCorsaId}`);
        const corsaRes = await client.query(`SELECT * FROM corse WHERE id = $1 FOR UPDATE`, [validCorsaId]);
        corsa = corsaRes.rows[0];
        if (isNccCondivisa && (!corsa ||
            String(corsa.tipo_corsa).trim().toLowerCase() !== 'condivisa' ||
            Number(corsa.veicolo_id) !== Number(pRow.veicolo_id) ||
            String(corsa.stato) !== 'prenotabile')) {
          const error = new Error('Corsa condivisa non disponibile o incompatibile: ripetere la ricerca');
          error.code = 'NCC_SHARED_COURSE_UNAVAILABLE';
          throw error;
        }
        
        if (!corsa) {
          console.warn(`⚠️ [ACCETTA] Corsa ID ${validCorsaId} non trovata. Creazione nuova corsa d'emergenza...`);
        }
      }

      // Se non esiste una corsa valida associata, la creiamo da zero o la gestiamo in base al tipo
      if (!corsa) {
        if (isNccCondivisa) {
          const error = new Error('Corsa condivisa non trovata: non è consentito crearne una sostitutiva');
          error.code = 'NCC_SHARED_COURSE_UNAVAILABLE';
          throw error;
        }
        if (isPopBus) {
          console.log(`🚌 [ACCETTA] Creazione corsa PopBus da pending...`);
          const resCorsa = await createCorsaFromPending(pRow, null, client, true, driverId);
          corsa = resCorsa.corsa ?? resCorsa;
          prenotazioneEffettuata = true; 
        } else {
          // Controllo conflitti rigoroso per le corse private/dedicate
          const conflictCheck = await client.query(
              `SELECT id FROM corse WHERE veicolo_id = $1 AND start_datetime = $2 AND stato != 'terminata' LIMIT 1`,
              [pRow.veicolo_id, pRow.start_datetime]
          );

          if (conflictCheck.rows.length > 0) {
              console.warn(`❌ [ACCETTA CONFLITTO] Il veicolo ${pRow.veicolo_id} è già impegnato nell'orario ${pRow.start_datetime}`);
              await client.query('ROLLBACK');
              return res.status(400).json({ error: "Il veicolo è già impegnato o prenotato in questo orario." });
          }

          console.log(`🚙 [ACCETTA] Creazione nuova corsa dedicata...`);
          // Base operativa dichiarata del veicolo (PostGIS geography, WGS84).
          const vRes = await client.query(`
            SELECT id, posti_totali,
                   ST_Y(coord::geometry) AS lat_base,
                   ST_X(coord::geometry) AS lon_base
            FROM veicolo
            WHERE id = $1
          `, [pRow.veicolo_id]);
          if (!vRes.rows.length) throw new Error(`Veicolo ${pRow.veicolo_id} non trovato`);
          const v = vRes.rows[0];
          const resCorsa = await createCorsaFromPending(pRow, {
            id: v.id,
            posti: v.posti_totali,
            posti_totali: v.posti_totali,
            lat_base: v.lat_base,
            lon_base: v.lon_base
          }, client, false);
          corsa = resCorsa.corsa ?? resCorsa;
          prenotazioneEffettuata = true; 
        }
        
        // Aggiorniamo il pending con il nuovo ID corsa corretto
        await client.query(`UPDATE pending SET corsa_id = $1 WHERE id = $2`, [corsa.id, pRow.id]);
      }

      if (!corsa) throw new Error("Impossibile recuperare o creare la corsa");

      // 🛠️ AGGIORNAMENTO FORZATO DEGLI INDIRIZZI REALI NELLA TABELLA CORSE
      // Gli indirizzi della missione condivisa non vanno sovrascritti
      // con quelli del nuovo passeggero agganciato.
      if (!isNccCondivisa) {
        await client.query(
          `UPDATE corse
           SET origine_address = $1,
               destinazione_address = $2
           WHERE id = $3`,
          [pRow.origine_address, pRow.destinazione_address, corsa.id]
        );
      }

      if (!prenotazioneEffettuata) {
          console.log(`🎟 [ACCETTA] Effettuazione prenotazione per corsa ID: ${corsa.id}, posti: ${pRow.posti_richiesti}`);
          await prenotaCorsa(corsa, pRow.cliente_id, pRow.posti_richiesti, segmenti, client);
      }
      const nuoveFermate = [
        {
          indirizzo: pRow.origine_address,
          lat: pRow.origine_lat,
          lon: pRow.origine_lon,
          tipo: 'ritiro',
          cliente_id: pRow.cliente_id
        },
        {
          indirizzo: pRow.destinazione_address,
          lat: pRow.destinazione_lat,
          lon: pRow.destinazione_lon,
          tipo: 'rilascio',
          cliente_id: pRow.cliente_id
        }
      ];

      const updateCorsaRes = await client.query(
        `UPDATE corse 
         SET fermate_pianificate = COALESCE(fermate_pianificate, '[]'::jsonb) || $1::jsonb 
         WHERE id = $2
         RETURNING *`,
        [JSON.stringify(nuoveFermate), corsa.id]
      );
      corsa = updateCorsaRes.rows[0];

      // Cache aggiornata dopo COMMIT.

      const prenotazioneRes = await client.query(
        `SELECT id FROM prenotazioni WHERE cliente_id = $1 AND corsa_id = $2 ORDER BY id DESC LIMIT 1`,
        [pRow.cliente_id, corsa.id]
      );
      const prenotazioneId = prenotazioneRes.rows[0]?.id;

      // MODELLO A: controlli di coerenza economica prima di registrare il pagamento.
      // La prenotazione (anche se creata internamente da createCorsaFromPending)
      // deve aver già congelato il totale e ricalcolato tutte le quote.
      if (!isPopBus && pRow.tipo_corsa === 'condivisa') {
        if (!prenotazioneId) {
          const error = new Error('Modello A: prenotazione non trovata dopo accettazione');
          error.code = 'NCC_MODEL_A_PAYMENT_INVALID';
          throw error;
        }
        const { rows: quoteRows } = await client.query(`
          SELECT pr.prezzo_totale, c.prezzo_fisso, c.prenotazione_origine_id
          FROM prenotazioni pr JOIN corse c ON c.id = pr.corsa_id
          WHERE pr.id = $1 AND c.id = $2
        `, [prenotazioneId, corsa.id]);
        const dati = quoteRows[0];
        const quotaCent = dati?.prezzo_totale == null ? NaN : Math.round(Number(dati.prezzo_totale) * 100);
        const fissoCent = dati?.prezzo_fisso == null ? NaN : Math.round(Number(dati.prezzo_fisso) * 100);
        const preventivoCent = pRow.prezzo == null ? NaN : Math.round(Number(pRow.prezzo) * 100);
        if (!Number.isSafeInteger(quotaCent) || quotaCent <= 0 ||
            !Number.isSafeInteger(fissoCent) || fissoCent <= 0 ||
            !Number.isSafeInteger(preventivoCent) || preventivoCent < quotaCent ||
            !Number.isInteger(Number(dati.prenotazione_origine_id))) {
          const error = new Error('Modello A: preventivo/autorizzazione insufficiente o snapshot non valido; ripetere la ricerca');
          error.code = 'NCC_MODEL_A_PAYMENT_INVALID';
          throw error;
        }
        if (!pRow.payment_intent_id || String(pRow.payment_intent_id).startsWith('wallet_')) {
          const error = new Error('Modello A: autorizzazione Stripe obbligatoria');
          error.code = 'NCC_MODEL_A_PAYMENT_INVALID';
          throw error;
        }
        const pi = await stripe.paymentIntents.retrieve(String(pRow.payment_intent_id));
        if (pi.status !== 'requires_capture' || Number(pi.amount_capturable) < quotaCent ||
            Number(pi.amount) !== preventivoCent) {
          const error = new Error('Modello A: Stripe non autorizzato o importo insufficiente');
          error.code = 'NCC_MODEL_A_PAYMENT_INVALID';
          throw error;
        }
      }

      if (pRow.payment_intent_id && prenotazioneId) {
        await client.query(
          `INSERT INTO pagamenti (prenotazione_id, importo, stato, stripe_payment_intent, corsa_id, updated_at)
            VALUES ($1, $2, 'autorizzazione', $3, $4, NOW())
            ON CONFLICT (stripe_payment_intent) 
            DO UPDATE SET prenotazione_id = $1, corsa_id = $4`,
          [prenotazioneId, pRow.prezzo, pRow.payment_intent_id, corsa.id]
        );
      }

      await client.query(
        `INSERT INTO chat_threads (corsa_id, cliente_id, driver_id, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [corsa.id, pRow.cliente_id, driverId]
      );

      notificheDaInviare.push({ p: pRow, corsa, driverId, driverNome });
    }

    await client.query('COMMIT');committed=true;
    console.log(`✅ [ACCETTA SUCCESS] Richiesta ${id} accettata con successo.`);
    
    const io = getIO();
    for (const data of notificheDaInviare) {
      const { p, corsa, driverId, driverNome } = data;
      upsertCorsa(corsa);CacheManager.corsa.update(corsa);
      const corsaCompleta = { ...corsa, corsa_id: corsa.id, veicolo_id: p.veicolo_id, pending_id: p.id, origine: { lat: p.origine_lat, lon: p.origine_lon }, destinazione: { lat: p.destinazione_lat, lon: p.destinazione_lon } };
      
      io.to(`autista_${driverId}`).emit('pending_update', { id: p.id, stato: 'accettata', corsa: corsaCompleta });
      io.to(`autista_${driverId}`).emit('nuova_corsa', corsaCompleta);
      io.to(`cliente_${p.cliente_id}`).emit('pending_update', { id: p.id, stato: 'accettata', corsa_id: corsa.id });
      
      await notifyUser(p.cliente_id, { 
        type: 'pending', 
        message: `Il tuo viaggio è stato accettato da ${driverNome}`,
        role: 'cliente',
        data: { corsaId: corsa.id }
      });
    }

    res.json({ ok: true });
  } catch (err) {
    if(committed){console.error('[PENDING POSTCOMMIT]',err.message);return res.json({ok:true,notifica_inviata:false});}
    await client.query('ROLLBACK');
    console.error(`❌ [ACCETTA ERRORE CRITICO] Fallita elaborazione ID ${id}:`, err.message);
    console.error(err.stack);

    try {
      // Errori di validazione/routing della missione NCC: non rifiutare
      // definitivamente il pending dopo il rollback; consentire un nuovo tentativo.
      if (!['NCC_MISSION_GEO_INVALID', 'NCC_MODEL_A_PAYMENT_INVALID', 'NCC_SHARED_COURSE_UNAVAILABLE'].includes(err.code)) {
        await pool.query(`UPDATE pending SET stato = 'rifiutata' WHERE id = $1 AND stato = 'pending'`, [id]);
      }
    } catch (cleanupErr) {
      console.error('❌ Impossibile pulire lo stato della richiesta fallita:', cleanupErr);
    }

    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

export { router as pendingRouter };