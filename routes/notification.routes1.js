// routes/notification.routes.js
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
import { sendNotification } from '../server.js'; // dalla versione aggiornata di server.js

const router = express.Router();

// -------------------- GET /notifications --------------------
// Restituisce tutte le notifiche per l'utente loggato
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

// -------------------- POST /notifications/mark-seen --------------------
// Segna tutte le notifiche come viste per l'utente loggato
router.post('/mark-seen', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    await pool.query(
      `UPDATE notifications SET seen = true WHERE user_id = $1`,
      [userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Mark notifications seen error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// -------------------- POST /notifications/create --------------------
// Endpoint per creare una nuova notifica
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { userId, role, type, message } = req.body;

    const result = await pool.query(
      `INSERT INTO notifications(user_id, type, message, seen, created_at)
       VALUES($1, $2, $3, false, NOW()) RETURNING *`,
      [userId, type, message]
    );

    const notification = result.rows[0];

    // 🔔 Invia subito via WebSocket nella stanza corretta
    sendNotification({ userId, role, notification });

    res.json(notification);
  } catch (err) {
    console.error('❌ Create notification error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// -------------------- GET /notifications/test/:userId --------------------
// Endpoint di debug senza autenticazione
router.get('/test/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;

    const result = await pool.query(
      `SELECT id, type, message, seen, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    console.log(`📬 Fetch test notifications for user ${userId}: ${result.rows.length} rows`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Fetch notifications test error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

export { router as notificationsRouter };