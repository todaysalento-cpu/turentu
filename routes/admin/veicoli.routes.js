import express from 'express';
import { pool } from '../../db/db.js';
import { authMiddleware, requireRole } from '../../middleware/auth.js';

const router = express.Router();

// GET: Lista veicoli
// Ho aggiunto un log di debug interno per vedere cosa arriva dal token
router.get('/', authMiddleware, requireRole('admin', 'Admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.*, u.nome AS nome_autista, u.email AS email_autista 
      FROM veicolo v
      LEFT JOIN utente u ON v.driver_id = u.id
      ORDER BY v.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Errore GET veicoli:', err);
    res.status(500).json({ error: 'Errore nel caricamento veicoli admin' });
  }
});

// PATCH: Approva o sospendi un veicolo
router.patch('/:id/stato', authMiddleware, requireRole('admin', 'Admin'), async (req, res) => {
  const { id } = req.params;
  const { stato_verifica } = req.body;
  
  try {
    const result = await pool.query(
      'UPDATE veicolo SET stato_verifica = $1 WHERE id = $2 RETURNING *',
      [stato_verifica, id]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Veicolo non trovato' });
    }
    
    res.json({ success: true, veicolo: result.rows[0] });
  } catch (err) {
    console.error('Errore PATCH veicolo:', err);
    res.status(500).json({ error: 'Errore aggiornamento stato' });
  }
});

export default router;