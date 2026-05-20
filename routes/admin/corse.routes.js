import express from 'express';
import { pool } from '../../db/db.js';
// Importiamo i middleware corretti
import { authMiddleware, requireRole } from '../../middleware/auth.js';

const router = express.Router();

// Proteggiamo la rotta con authMiddleware (per verificare il token) 
// e requireRole('Admin') (per verificare il ruolo)
router.get('/', authMiddleware, requireRole('Admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, v.marca, v.modello, v.targa 
      FROM corse c
      JOIN veicolo v ON c.veicolo_id = v.id
      ORDER BY c.start_datetime DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Errore nel recupero corse admin:', err);
    res.status(500).json({ error: 'Errore nel recupero corse' });
  }
});

export default router;