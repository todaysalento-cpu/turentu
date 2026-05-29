import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';

const router = express.Router();

/**
 * GET /api/prenotazioni
 * Recupera le prenotazioni in stato 'pending' per il cliente autenticato,
 * escludendo automaticamente quelle scadute.
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const clienteId = req.user.id;

    // Utilizziamo un filtro temporale (expires_at > NOW()) per garantire
    // che l'utente non veda richieste che non sono più processabili.
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
        AND stato = 'pending'
        AND expires_at > NOW()
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

/**
 * Nota architetturale: 
 * Ti consiglio vivamente di implementare una pulizia automatica 
 * delle righe scadute nel database tramite un task pianificato.
 * * Esempio di query di pulizia (da eseguire via cron):
 * DELETE FROM pending 
 * WHERE stato = 'pending' AND expires_at < NOW();
 */

export default router;