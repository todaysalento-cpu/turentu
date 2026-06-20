import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/db.js';
// Importiamo il nuovo servizio centralizzato
import { notifyUser } from '../services/notifications/notification.service.js';

const router = express.Router();

// --- Funzioni di utilità ---
function generateNotificationMessage({ type, corsaId, startAddress, endAddress, userRole }) {
  if (type === 'pending') {
    return userRole === 'autista'
      ? `Nuova corsa da confermare 🏁 ${startAddress} → ${endAddress}`
      : `Hai richiesto una corsa 🏁 ${startAddress} → ${endAddress}`;
  }
  if (type === 'info') return `La corsa è stata completata ✅`;
  return 'Nuova notifica';
}

function formatNotificationDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const time = date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) return `oggi alle ${time}`;
  if (isYesterday) return `ieri alle ${time}`;
  const dayName = date.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit' });
  return `${dayName} alle ${time}`;
}

// --- Rotte ---

// 1. Recupero notifiche
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

    const notifications = result.rows.map(n => ({
      ...n,
      displayDate: formatNotificationDate(n.created_at),
      seen: n.seen === true || n.seen === 't'
    }));

    res.json(notifications);
  } catch (err) {
    console.error('❌ [NOTIF] Fetch error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// 2. Registrazione Push Token (AGGIONATO: DELETE + INSERT per compatibilità totale)
router.post('/register-token', authMiddleware, async (req, res) => {
  try {
    const { pushToken } = req.body;
    const userId = req.user.id;

    if (!pushToken) {
      return res.status(400).json({ message: 'Push token mancante' });
    }

    console.log(`📥 [NOTIF_DB] Registrazione token per utente ${userId}`);

    // Pulizia: rimuoviamo il vecchio token per evitare duplicati
    await pool.query(`DELETE FROM utente_push_tokens WHERE user_id = $1`, [userId]);

    // Inserimento pulito
    await pool.query(
      `INSERT INTO utente_push_tokens (user_id, push_token, created_at) 
       VALUES ($1, $2, NOW())`,
      [userId, pushToken]
    );

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ [NOTIF_DB] Errore salvataggio token:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

// 3. Segna come letto
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
    res.status(500).json({ message: 'Errore server' });
  }
});

// 4. Crea notifica
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { type, targetUserId, corsaId, startAddress, endAddress } = req.body;
    const userId = targetUserId || req.user.id;

    const roleRes = await pool.query(`SELECT role FROM users WHERE id = $1`, [userId]);
    const userRole = roleRes.rows[0]?.role;
    
    if (!userRole) return res.status(400).json({ message: 'Utente non trovato' });

    const message = generateNotificationMessage({ type, corsaId, startAddress, endAddress, userRole });

    const notification = await notifyUser(userId, { 
      type, 
      message, 
      role: userRole,
      data: { corsaId } 
    });

    console.log(`✅ [NOTIF] Notifica inviata e salvata ID: ${notification.id}`);
    
    notification.displayDate = formatNotificationDate(notification.created_at);
    res.json(notification);

  } catch (err) {
    console.error('❌ [NOTIF] Create notification error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});

export { router as notificationsRouter };