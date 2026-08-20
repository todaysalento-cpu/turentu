import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getIO } from '../socket.js';
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';
import { createCorsaFromPending } from '../services/corsa/corsa.service.js';
import { upsertCorsa } from '../services/search/search.cache.js';
import { CacheManager } from '../utils/cacheManager.js';
import { notifyUser } from '../services/notifications/notification.service.js';

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
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pending non trovato' });
    }

    const p = pendingRes.rows[0];
    if (p.stato !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Non disponibile' });
    }

    const result = await client.query(
      `UPDATE pending SET stato = 'accettata' WHERE id = $1 
       RETURNING *, ST_X(origine::geometry) AS origine_lon, ST_Y(origine::geometry) AS origine_lat,
       ST_X(destinazione::geometry) AS destinazione_lon, ST_Y(destinazione::geometry) AS destinazione_lat`,
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

      const segmenti = { 
          startIdx: pRow.start_index_polyline ?? 0, 
          endIdx: pRow.end_index_polyline ?? 100 
      };

      let corsa;
      let prenotazioneEffettuata = false;

      if (!pRow.corsa_id) {
        if (isPopBus) {
            const resCorsa = await createCorsaFromPending(pRow, null, client, true, driverId);
            corsa = resCorsa.corsa;
            prenotazioneEffettuata = true; 
        } else {
            const existing = await client.query(
              `SELECT * FROM corse WHERE veicolo_id = $1 AND start_datetime = $2 AND stato != 'terminata' LIMIT 1`,
              [pRow.veicolo_id, pRow.start_datetime]
            );
            
            if (existing.rows.length) {
              corsa = existing.rows[0];
            } else {
              const vRes = await client.query('SELECT posti_totali FROM veicolo WHERE id = $1', [pRow.veicolo_id]);
              const resCorsa = await createCorsaFromPending(pRow, { id: pRow.veicolo_id, posti: vRes.rows[0]?.posti_totali ?? 4 }, client, false);
              corsa = resCorsa.corsa;
              prenotazioneEffettuata = true; 
              await client.query(`UPDATE pending SET corsa_id = $1 WHERE id = $2`, [corsa.id, pRow.id]);
            }
        }
      } else {
        const corsaRes = await client.query(`SELECT * FROM corse WHERE id = $1`, [pRow.corsa_id]);
        corsa = corsaRes.rows[0];
      }

      if (!corsa) throw new Error("Impossibile recuperare o creare la corsa");

      if (!prenotazioneEffettuata) {
          await prenotaCorsa(corsa, pRow.cliente_id, pRow.posti_richiesti, segmenti, client);
      }

      // Salvataggio delle fermate pianificate (ritiro e rilascio) nella tabella corse
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

      upsertCorsa(corsa);
      CacheManager.corsa.update(corsa);

      const prenotazioneRes = await client.query(
        `SELECT id FROM prenotazioni WHERE cliente_id = $1 AND corsa_id = $2 ORDER BY id DESC LIMIT 1`,
        [pRow.cliente_id, corsa.id]
      );
      const prenotazioneId = prenotazioneRes.rows[0]?.id;

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

    await client.query('COMMIT');
    
    const io = getIO();
    for (const data of notificheDaInviare) {
      const { p, corsa, driverId, driverNome } = data;
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
    await client.query('ROLLBACK');
    console.error('❌ Errore accetta:', err);

    try {
      await pool.query(`UPDATE pending SET stato = 'rifiutata' WHERE id = $1 AND stato = 'pending'`, [id]);
    } catch (cleanupErr) {
      console.error('❌ Impossibile pulire lo stato della richiesta fallita:', cleanupErr);
    }

    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export { router as pendingRouter };