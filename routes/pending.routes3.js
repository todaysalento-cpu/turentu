// ======================= routes/pending.routes.js =======================
import express from 'express';
import { pool } from '../db/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { io } from '../server.js';
import { prenotaCorsa } from '../services/prenotazione/prenotazione.service.js';
import { createCorsaFromPending } from '../services/corsa/corsa.service.js';

const router = express.Router();
router.use(authMiddleware);

// -------------------- GET pending per autista --------------------
router.get('/autista/:id', async (req, res) => {
  try {
    const autistaId = Number(req.params.id);

    const result = await pool.query(
      `SELECT * FROM pending WHERE veicolo_id=$1 AND stato='pending' ORDER BY created_at DESC`,
      [autistaId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Pending autista error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- POST accetta pending --------------------
router.post('/:id/accetta', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const { allSlots = false } = req.body;

    // Recupera pending e blocca riga per aggiornamento
    const pendingRes = await client.query(
      'SELECT * FROM pending WHERE id=$1 FOR UPDATE',
      [id]
    );
    if (!pendingRes.rows.length)
      return res.status(404).json({ message: 'Pending non trovato' });

    await client.query('BEGIN');

    let acceptedPendings = [];

    if (allSlots && pendingRes.rows[0].request_id) {
      // Accetta tutti i pending dello stesso request_id
      const result = await client.query(
        `UPDATE pending SET stato='accettata'
         WHERE request_id=$1
         RETURNING *`,
        [pendingRes.rows[0].request_id]
      );
      acceptedPendings = result.rows;

      // Elimina tutti gli altri pending non accettati
      await client.query(
        `DELETE FROM pending
         WHERE request_id=$1 AND stato<>'accettata'`,
        [pendingRes.rows[0].request_id]
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

    const prenotazioni = [];

    for (const p of acceptedPendings) {
      let corsa, prenotazione;

      if (!p.corsa_id) {
        // 🔹 CREA CORSA TRAMITE SERVICE
        const veicolo = { id: p.veicolo_id, posti: 4 }; // adattare se posti reali disponibili
        const corsaResult = await createCorsaFromPending(p, veicolo, client);

        corsa = corsaResult.corsa;
        prenotazione = corsaResult.prenotazione;

        // Aggiorna pending con corsa_id
        await client.query(
          `UPDATE pending SET corsa_id=$1 WHERE id=$2`,
          [corsa.id, p.id]
        );

        prenotazioni.push(prenotazione);

      } else {
        // 🔹 Recupera corsa esistente
        const corsaRes = await client.query(
          `SELECT * FROM corse WHERE id=$1`,
          [p.corsa_id]
        );
        if (!corsaRes.rows.length)
          throw new Error("Oggetto corsa non valido o manca id");

        corsa = corsaRes.rows[0];

        // Prenota corsa esistente
        const pren = await prenotaCorsa(corsa, p.cliente_id, p.posti_richiesti, client);
        prenotazioni.push(pren);
      }
    }

    await client.query('COMMIT');

    // 🔔 Notifica via Socket.io
    for (const p of acceptedPendings) {
      io.to(`autista_${p.veicolo_id}`).emit('pending_update', { ...p, stato: 'accettata' });
      io.to(`cliente_${p.cliente_id}`).emit(
        'prenotazione_creata',
        prenotazioni.find(pr => pr.cliente_id === p.cliente_id)
      );
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

export { router as pendingRouter };
