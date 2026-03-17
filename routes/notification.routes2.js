import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
import { sendNotification } from '../server.js';

const router = express.Router();

// GET tutte le notifiche per utente loggato
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT id, type, message, seen, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Fetch notifications error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// POST mark-seen singola notifica
router.post('/mark-seen', authMiddleware, async (req, res) => {
  try {
    const { id } = req.body;
    const userId = req.user.id;

    await pool.query(
      `UPDATE notifications SET seen = true WHERE user_id = $1 AND id = $2`,
      [userId, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Mark notifications seen error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// POST crea notifica
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { type, message, targetUserId } = req.body;

    const userId = targetUserId || req.user.id;

    // 🔹 Ottieni ruolo del destinatario
    const roleRes = await pool.query(
      `SELECT role FROM users WHERE id = $1`,
      [userId]
    );
    const userRole = roleRes.rows[0]?.role;
    if (!userRole) return res.status(400).json({ message: 'Utente non trovato' });

    const result = await pool.query(
      `INSERT INTO notifications(user_id, type, message, seen, created_at)
       VALUES($1, $2, $3, false, NOW()) RETURNING *`,
      [userId, type, message]
    );

    const notification = result.rows[0];

    // 🔔 Invia live al destinatario
    sendNotification({ userId, role: userRole, notification });

    res.json(notification);
  } catch (err) {
    console.error('❌ Create notification error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

export { router as notificationsRouter };