// routes/admin/gestione.routes.js
import express from 'express';
import { pool } from '../../db/db.js';

const router = express.Router();

// GET /admin/gestione
router.get('/', async (req, res) => {
  try {
    // Recupera gli utenti dal DB selezionando anche la data di creazione
    // Utilizziamo l'alias 'data_creazione' per mappare il campo del DB 'created_at'
    const result = await pool.query(`
      SELECT 
        id, 
        nome, 
        email, 
        tipo AS ruolo, 
        created_at AS data_creazione 
      FROM utente 
      ORDER BY created_at DESC
    `);

    res.json(result.rows); 
  } catch (err) {
    console.error('❌ Gestione admin error:', err.message);
    res.status(500).json({ error: 'Errore interno server' });
  }
});

export default router;