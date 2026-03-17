// ======================= routes/pending.routes.js =======================
import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { io } from '../server.js';
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';

const router = express.Router();

// Tutte le rotte richiedono login
router.use(authMiddleware);

// -------------------- GET pending per autista --------------------
router.get('/autista/:id', async (req, res) => {
  try {
    const autistaId = Number(req.params.id);
    const statusFilter = req.query.status || 'pending';

    const result = await pool.query(
      `SELECT p.*, u.nome AS cliente
       FROM pending p
       JOIN utente u ON u.id = p.cliente_id
       WHERE p.veicolo_id IN (
         SELECT id FROM veicolo WHERE driver_id=$1
       )
         AND p.stato=$2
       ORDER BY p.start_datetime ASC`,
      [autistaId, statusFilter]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Pending fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- POST accetta pending --------------------
router.post('/:id/accetta', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const { allSlots = false } = req.body;

    // Recupera pending
    const pendingRes = await client.query(
      'SELECT * FROM pending WHERE id=$1 FOR UPDATE',
      [id]
    );
    if (!pendingRes.rows.length) return res.status(404).json({ message: 'Pending non trovato' });
    const pending = pendingRes.rows[0];

    if (!pending.payment_intent_id) {
      throw new Error("Pending senza payment_intent_id non gestito");
    }

    await client.query('BEGIN');

    let acceptedPendings = [];

    if (allSlots && pending.request_id) {
      // Accetta tutti i pending dello stesso request_id
      const result = await client.query(
        `UPDATE pending SET stato='accettata'
         WHERE request_id=$1
         RETURNING *`,
        [pending.request_id]
      );
      acceptedPendings = result.rows;

      // Elimina tutti gli altri pending dello stesso request_id non accettati
      await client.query(
        `DELETE FROM pending
         WHERE request_id=$1
           AND stato<>'accettata'`,
        [pending.request_id]
      );

    } else {
      // Accetta solo il singolo pending
      const result = await client.query(
        `UPDATE pending SET stato='accettata'
         WHERE id=$1
         RETURNING *`,
        [id]
      );
      acceptedPendings = result.rows;
    }

    // Crea prenotazioni per ogni pending accettato
    const prenotazioni = [];
    for (const p of acceptedPendings) {
      const corsa = { id: p.corsa_id, tipo_corsa: p.tipo_corsa };
      const pren = await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
      prenotazioni.push(pren);
    }

    await client.query('COMMIT');

    // 🔔 Notifica socket
    for (const p of acceptedPendings) {
      io.to(`autista_${p.veicolo_id}`).emit('pending_update', { ...p, stato: 'accettata' });
      io.to(`cliente_${p.cliente_id}`).emit('prenotazione_creata', prenotazioni.find(pr => pr.cliente_id === p.cliente_id));
    }

    res.json({ acceptedPendings, prenotazioni });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Pending accept error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// -------------------- POST crea nuovo pending --------------------
router.post('/', async (req, res) => {
  try {
    const {
      veicolo_id,
      cliente_id,
      start_datetime,
      durata,
      posti_richiesti,
      tipo_corsa,
      prezzo,
      origine,
      destinazione,
      payment_intent_id,
      request_id,
      corsa_id
    } = req.body;

    const result = await pool.query(
      `INSERT INTO pending 
        (veicolo_id, cliente_id, start_datetime, durata, posti_richiesti, tipo_corsa, prezzo, origine, destinazione, stato, payment_intent_id, request_id, corsa_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12)
       RETURNING *`,
      [veicolo_id, cliente_id, start_datetime, durata, posti_richiesti, tipo_corsa, prezzo, origine, destinazione, payment_intent_id, request_id, corsa_id]
    );

    const newPending = result.rows[0];

    // 🔔 Notifica Socket.io all'autista
    io.to(`autista_${newPending.veicolo_id}`).emit('pending_update', newPending);

    res.json(newPending);
  } catch (err) {
    console.error('❌ Pending create error:', err);
    res.status(500).json({ error: err.message });
  }
});

export { router as pendingRouter };
