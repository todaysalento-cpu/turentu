import express from 'express';
import { pool } from '../../db/db.js';
import { authMiddleware, requireRole } from '../../middleware/auth.js';

const router = express.Router();

// Rotta per recuperare le entità in stato di "pending"
// Aggiornato per accettare sia 'Admin' che 'admin'
router.get('/', authMiddleware, requireRole('Admin', 'admin'), async (req, res) => {
  try {
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

// Rotta per approvare/rifiutare una richiesta
router.patch('/:id/update-status', authMiddleware, requireRole('Admin', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { nuovo_stato } = req.body; // Es: 'approvato' o 'rifiutato'

  try {
    const result = await pool.query(
      'UPDATE pagamenti SET stato = $1 WHERE id = $2 RETURNING *',
      [nuovo_stato, id]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Richiesta non trovata' });
    }
    
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Errore aggiornamento stato pending:', err);
    res.status(500).json({ error: 'Errore aggiornamento stato' });
  }
});

export default router;