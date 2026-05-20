import express from 'express';
import { pool } from '../../db/db.js';
import { authMiddleware, requireRole } from '../../middleware/auth.js';

const router = express.Router();

// Rotta per recuperare le richieste in stato di "pending"
router.get('/', authMiddleware, requireRole('Admin', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, veicolo_id, cliente_id, start_datetime, prezzo, 
        origine_address, destinazione_address, stato, created_at 
      FROM pending 
      WHERE stato = 'pending' 
      ORDER BY created_at ASC
    `);
    
    res.json(result.rows);
  } catch (err) {
    console.error('Errore nel recupero dati pending:', err);
    res.status(500).json({ error: 'Errore nel recupero delle richieste in attesa' });
  }
});

// Rotta per aggiornare lo stato di una richiesta (es: 'approvato', 'rifiutato')
router.patch('/:id/update-status', authMiddleware, requireRole('Admin', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { nuovo_stato } = req.body; 

  try {
    const result = await pool.query(
      'UPDATE pending SET stato = $1 WHERE id = $2 RETURNING *',
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