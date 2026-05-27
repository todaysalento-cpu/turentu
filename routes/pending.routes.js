import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { sendNotification, getIO } from '../socket.js';
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';
import { createCorsaFromPending } from '../services/corsa/corsa.service.js';

const router = express.Router();
router.use(authMiddleware);

// --- LOG DI DEBUG PER IL ROUTING ---
router.use((req, res, next) => {
  console.log(`📌 [DEBUG ROUTER] Richiesta ricevuta: ${req.method} ${req.originalUrl} | Path: ${req.path}`);
  next();
});

// -------------------- POST accetta pending --------------------
router.post('/:id/accetta', async (req, res) => {
  console.log(`🚀 [DEBUG] Tentativo di accettazione per ID: ${req.params.id}`);
  
  const client = await pool.connect();
  const notificheDaInviare = [];

  try {
    const id = Number(req.params.id);
    await client.query('BEGIN');

    const pendingRes = await client.query(
      `SELECT * FROM pending WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (!pendingRes.rows.length) {
      console.warn(`⚠️ [DEBUG] Pending ${id} non trovato nel DB`);
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pending non trovato' });
    }

    const selectedPending = pendingRes.rows[0];

    if (selectedPending.stato !== 'pending') {
      console.warn(`⚠️ [DEBUG] Pending ${id} stato non valido: ${selectedPending.stato}`);
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Non disponibile' });
    }

    if (selectedPending.request_id) {
      const alreadyAccepted = await client.query(
        `SELECT id FROM pending WHERE request_id = $1 AND stato = 'accettata' FOR UPDATE`,
        [selectedPending.request_id]
      );

      if (alreadyAccepted.rows.length) {
        console.warn(`⚠️ [DEBUG] Tentativo di doppia accettazione per request_id: ${selectedPending.request_id}`);
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Già accettata' });
      }
    }

    const result = await client.query(
      `UPDATE pending 
       SET stato = 'accettata' 
       WHERE id = $1 
       RETURNING *,
         ST_X(origine::geometry) AS origine_lon,
         ST_Y(origine::geometry) AS origine_lat,
         ST_X(destinazione::geometry) AS destinazione_lon,
         ST_Y(destinazione::geometry) AS destinazione_lat`,
      [id]
    );

    for (const p of result.rows) {
      const driverRes = await client.query(
        `SELECT v.driver_id, u.nome AS driver_nome
         FROM veicolo v
         JOIN utente u ON u.id = v.driver_id
         WHERE v.id = $1`,
        [p.veicolo_id]
      );

      const driverId = driverRes.rows[0]?.driver_id;
      const driverNome = driverRes.rows[0]?.driver_nome ?? 'Autista N/D';

      let corsa;

      if (!p.corsa_id) {
        const existing = await client.query(
          `SELECT * FROM corse 
           WHERE veicolo_id = $1 AND start_datetime = $2 AND stato != 'terminata' LIMIT 1`,
          [p.veicolo_id, p.start_datetime]
        );

        if (existing.rows.length) {
          corsa = existing.rows[0];
          await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
        } else {
          const vRes = await client.query('SELECT posti_totali FROM veicolo WHERE id = $1', [p.veicolo_id]);
          const postiReali = vRes.rows[0]?.posti_totali ?? 4;
          
          const veicolo = { id: p.veicolo_id, posti: postiReali };
          const resCorsa = await createCorsaFromPending(p, veicolo, client);
          
          corsa = resCorsa.corsa;
          await client.query(`UPDATE pending SET corsa_id = $1 WHERE id = $2`, [corsa.id, p.id]);
        }
      } else {
        const corsaRes = await client.query(`SELECT * FROM corse WHERE id = $1`, [p.corsa_id]);
        corsa = corsaRes.rows[0];
        await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
      }

      if (p.payment_intent_id) {
        await client.query(
          `UPDATE pagamenti 
           SET corsa_id = $1 
           WHERE stripe_payment_intent = $2 AND corsa_id IS NULL`,
          [corsa.id, p.payment_intent_id]
        );
      }

      notificheDaInviare.push({ p, corsa, driverId, driverNome });
    }

    await client.query('COMMIT');
    console.log(`✅ [DEBUG] Transazione completata per pending ${id}`);

    const io = getIO();
    for (const data of notificheDaInviare) {
      const { p, corsa, driverId, driverNome } = data;
      const corsaCompleta = {
        ...corsa,
        corsa_id: corsa.id,
        veicolo_id: p.veicolo_id,
        pending_id: p.id,
        origine: { lat: p.origine_lat, lon: p.origine_lon },
        destinazione: { lat: p.destinazione_lat, lon: p.destinazione_lon },
        origine_address: p.origine_address,
        destinazione_address: p.destinazione_address,
      };

      io.to(`autista_${driverId}`).emit('pending_update', { id: p.id, stato: 'accettata', corsa: corsaCompleta });
      io.to(`autista_${driverId}`).emit('nuova_corsa', corsaCompleta);
      io.to(`cliente_${p.cliente_id}`).emit('pending_update', { id: p.id, stato: 'accettata', corsa_id: corsa.id });

      sendNotification({
        userId: p.cliente_id,
        title: 'Viaggio accettato',
        message: `Il tuo viaggio è stato accettato da ${driverNome}`,
        type: 'pending'
      });
    }

    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [DEBUG] Errore critico:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export { router as pendingRouter };