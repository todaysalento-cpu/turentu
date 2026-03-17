// routes/admin/gestione.routes.js
import express from 'express';
import { pool } from '../../db/db.js'; // Assicurati che il path sia corretto

const router = express.Router();

// GET /admin/gestione
router.get('/', async (req, res) => {
  try {
    // Recupera gli utenti dal DB
    const result = await pool.query(
      'SELECT id, nome, email, tipo AS ruolo FROM utente ORDER BY id'
    );

    res.json(result.rows); // restituisce direttamente un array di utenti
  } catch (err) {
    console.error('❌ Gestione admin error:', err.message);
    res.status(500).json({ error: 'Errore interno server' });
  }
});

export default router;