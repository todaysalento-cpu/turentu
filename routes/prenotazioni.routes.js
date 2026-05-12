import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';

const router = express.Router();

router.get('/prenotazioni', authMiddleware, async (req, res) => {
  try {
    const clienteId = req.user.id;

    const result = await pool.query(
      `
      SELECT 
        id,
        veicolo_id,
        cliente_id,
        start_datetime,
        durata,
        posti_richiesti,
        tipo_corsa,
        prezzo,
        distanza,
        origine_address,
        destinazione_address,
        stato,
        request_id,
        expires_at,
        created_at
      FROM pending
      WHERE cliente_id = $1
      ORDER BY start_datetime DESC
      `,
      [clienteId]
    );

    res.json(result.rows);

  } catch (err) {
    console.error('❌ Errore GET prenotazioni:', err);
    res.status(500).json({ error: 'Errore nel recupero prenotazioni' });
  }
});

export default router;