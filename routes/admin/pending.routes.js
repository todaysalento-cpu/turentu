import express from 'express';
import { pool } from '../../db/db.js';
import { adminMiddleware } from '../../middleware/admin.js'; // Assicurati di avere un middleware per l'admin

const router = express.Router();

router.get('/', adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, v.marca, v.modello, v.targa 
      FROM corse c
      JOIN veicolo v ON c.veicolo_id = v.id
      ORDER BY c.start_datetime DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Errore nel recupero corse' });
  }
});

export default router;