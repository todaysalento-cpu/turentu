import express from 'express';
import { pool } from '../../db/db.js';
// Importiamo i middleware corretti da auth.js
import { authMiddleware, requireRole } from '../../middleware/auth.js';

const router = express.Router();

// Rotta per recuperare le entità in stato di "pending" (es. pagamenti o verifiche documenti)
router.get('/', authMiddleware, requireRole('Admin'), async (req, res) => {
  try {
    // Esempio query: recupera elementi con stato 'pending'
    // Adatta la query alla tua tabella specifica (es. pagamenti o verifiche)
    const result = await pool.query(`
      SELECT * 
      FROM pagamenti 
      WHERE stato = 'pending' 
      ORDER BY created_at ASC
    `);
    
    res.json(result.rows);
  } catch (err) {
    console.error('Errore nel recupero dati pending:', err);
    res.status(500).json({ error: 'Errore nel recupero dei dati in sospeso' });
  }
});

// Esempio di rotta per approvare/rifiutare una richiesta
router.patch('/:id/update-status', authMiddleware, requireRole('Admin'), async (req, res) => {
  const { id } = req.params;
  const { nuovo_stato } = req.body; // Es: 'approvato' o 'rifiutato'

  try {
    await pool.query(
      'UPDATE pagamenti SET stato = $1 WHERE id = $2',
      [nuovo_stato, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Errore aggiornamento stato pending:', err);
    res.status(500).json({ error: 'Errore aggiornamento stato' });
  }
});

export default router;