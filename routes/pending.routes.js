import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { sendNotification, getIO } from '../socket.js';
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';
import { createCorsaFromPending } from '../services/corsa/corsa.service.js';

const router = express.Router();
router.use(authMiddleware);

// --- LOG DI DEBUG ---
router.use((req, res, next) => {
  console.log(`📌 [DEBUG ROUTER] ${req.method} ${req.originalUrl}`);
  next();
});

// -------------------- GET Lista Pending --------------------
router.get('/autista/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT *, COALESCE(prezzo, 0)::float8 AS prezzo 
       FROM pending 
       WHERE veicolo_id = $1 AND stato = 'pending'`,
      [id]
    );
    res.json({ pendings: result.rows });
  } catch (err) {
    console.error('❌ Errore GET /autista/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- POST accetta pending --------------------
router.post('/:id/accetta', async (req, res) => {
  const client = await pool.connect();
  const notificheDaInviare = [];

  try {
    const id = Number(req.params.id);
    await client.query('BEGIN');

    const pendingRes = await client.query(`SELECT * FROM pending WHERE id = $1 FOR UPDATE`, [id]);

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

    for (const p of result.rows) {
      const driverRes = await client.query(
        `SELECT v.driver_id, u.nome AS driver_nome FROM veicolo v 
         JOIN utente u ON u.id = v.driver_id WHERE v.id = $1`, [p.veicolo_id]
      );

      const driverId = driverRes.rows[0]?.driver_id;
      const driverNome = driverRes.rows[0]?.driver_nome ?? 'Autista N/D';

      let corsa;
      if (!p.corsa_id) {
        const existing = await client.query(
          `SELECT * FROM corse WHERE veicolo_id = $1 AND start_datetime = $2 AND stato != 'terminata' LIMIT 1`,
          [p.veicolo_id, p.start_datetime]
        );
        if (existing.rows.length) {
          corsa = existing.rows[0];
          await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
        } else {
          const vRes = await client.query('SELECT posti_totali FROM veicolo WHERE id = $1', [p.veicolo_id]);
          const resCorsa = await createCorsaFromPending(p, { id: p.veicolo_id, posti: vRes.rows[0]?.posti_totali ?? 4 }, client);
          corsa = resCorsa.corsa;
          await client.query(`UPDATE pending SET corsa_id = $1 WHERE id = $2`, [corsa.id, p.id]);
        }
      } else {
        const corsaRes = await client.query(`SELECT * FROM corse WHERE id = $1`, [p.corsa_id]);
        corsa = corsaRes.rows[0];
        await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
      }

      // 🔥 FIX: Recupero ID prenotazione reale per soddisfare la Foreign Key
      const prenotazioneRes = await client.query(
        `SELECT id FROM prenotazioni WHERE cliente_id = $1 AND corsa_id = $2 ORDER BY id DESC LIMIT 1`,
        [p.cliente_id, corsa.id]
      );
      const prenotazioneId = prenotazioneRes.rows[0]?.id;

      // 🔥 FIX: Inserimento/Aggiornamento pagamenti sicuro
      if (p.payment_intent_id && prenotazioneId) {
        await client.query(
          `INSERT INTO pagamenti (prenotazione_id, importo, stato, stripe_payment_intent, corsa_id, updated_at)
           VALUES ($1, $2, 'autorizzazione', $3, $4, NOW())
           ON CONFLICT (stripe_payment_intent) 
           DO UPDATE SET prenotazione_id = $1, corsa_id = $4`,
          [prenotazioneId, p.prezzo, p.payment_intent_id, corsa.id]
        );
      }

      notificheDaInviare.push({ p, corsa, driverId, driverNome });
    }

    await client.query('COMMIT');
    
    // Notifiche (post-commit)
    const io = getIO();
    for (const data of notificheDaInviare) {
      const { p, corsa, driverId, driverNome } = data;
      const corsaCompleta = { ...corsa, corsa_id: corsa.id, veicolo_id: p.veicolo_id, pending_id: p.id, origine: { lat: p.origine_lat, lon: p.origine_lon }, destinazione: { lat: p.destinazione_lat, lon: p.destinazione_lon } };
      io.to(`autista_${driverId}`).emit('pending_update', { id: p.id, stato: 'accettata', corsa: corsaCompleta });
      io.to(`autista_${driverId}`).emit('nuova_corsa', corsaCompleta);
      io.to(`cliente_${p.cliente_id}`).emit('pending_update', { id: p.id, stato: 'accettata', corsa_id: corsa.id });
      sendNotification({ userId: p.cliente_id, title: 'Viaggio accettato', message: `Il tuo viaggio è stato accettato da ${driverNome}`, type: 'pending' });
    }

    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Errore accetta:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export { router as pendingRouter };