import express from 'express';
import { pool } from '../../db/db.js';
// Usiamo i middleware corretti che hai già definito in auth.js
import { authMiddleware, requireRole } from '../../middleware/auth.js';

const router = express.Router();

// Applichiamo authMiddleware per verificare il token
// E requireRole('Admin') per assicurarci che solo gli admin accedano
router.get('/', authMiddleware, requireRole('Admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.*, u.nome AS nome_autista, u.email AS email_autista 
      FROM veicolo v
      LEFT JOIN utente u ON v.driver_id = u.id
      ORDER BY v.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Errore GET veicoli admin:', err);
    res.status(500).json({ error: 'Errore nel caricamento veicoli admin' });
  }
});

router.patch('/:id/stato', authMiddleware, requireRole('Admin'), async (req, res) => {
  const { id } = req.params;
  const { stato_verifica } = req.body; 
  
  try {
    await pool.query(
      'UPDATE veicolo SET stato_verifica = $1 WHERE id = $2',
      [stato_verifica, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Errore PATCH stato veicolo:', err);
    res.status(500).json({ error: 'Errore aggiornamento stato' });
  }
});

export default router;