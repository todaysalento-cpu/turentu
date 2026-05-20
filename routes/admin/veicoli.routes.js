import express from 'express';
import { pool } from '../../db/db.js';
import { adminMiddleware } from '../../middleware/admin.js';

const router = express.Router();

// GET: Lista veicoli con dettagli autista (Join necessario)
router.get('/', adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.*, u.nome AS nome_autista, u.email AS email_autista 
      FROM veicolo v
      LEFT JOIN utente u ON v.driver_id = u.id
      ORDER BY v.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Errore nel caricamento veicoli admin' });
  }
});

// PATCH: Approva o sospendi un veicolo
router.patch('/:id/stato', adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { stato_verifica } = req.body; // Esempio: 'approvato', 'sospeso'
  
  try {
    await pool.query(
      'UPDATE veicolo SET stato_verifica = $1 WHERE id = $2',
      [stato_verifica, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Errore aggiornamento stato' });
  }
});

export default router;