import { pool } from '../../db/db.js';
import { sendPush } from './push.service.js'; 
import { getIO } from '../../socket.js';

/**
 * Servizio centralizzato per l'invio di notifiche
 */
export const notifyUser = async (userId, { type, title = 'Nuova Notifica', message, role, data = {} }) => {
  try {
    // 1. SALVATAGGIO NEL DATABASE
    const result = await pool.query(
      `INSERT INTO notifications(user_id, type, message, seen, created_at) 
       VALUES ($1, $2, $3, false, NOW()) RETURNING *`,
      [userId, type, message]
    );
    const notification = result.rows[0];

    // 2. INVIO VIA SOCKET (Real-time)
    try {
      const io = getIO();
      const room = `${role === 'driver' ? 'autista' : role}_${userId}`;
      io.to(room).emit("new_notification", { ...notification, sentAt: Date.now() });
      console.log(`🚀 [SOCKET] Notifica inviata in stanza: ${room}`);
    } catch (e) {
      console.warn("⚠️ [SOCKET] Socket non disponibile:", e.message);
    }

    // 3. INVIO PUSH (Background)
    const tokenRes = await pool.query(
      'SELECT push_token FROM utente_push_tokens WHERE user_id = $1 LIMIT 1', 
      [userId]
    );

    if (tokenRes.rows.length > 0) {
      const token = tokenRes.rows[0].push_token;
      
      // Passiamo il titolo dinamico al nuovo servizio sendPush
      const pushResult = await sendPush(
        token, 
        title, 
        message, 
        { ...data, notificationId: notification.id }
      );

      // Gestione post-invio: se il token non è più valido, lo eliminiamo
      const ticket = pushResult?.data ? pushResult.data[0] : null;
      if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        console.warn(`🗑️ [PUSH] Token invalido per utente ${userId}, rimozione dal DB.`);
        await pool.query('DELETE FROM utente_push_tokens WHERE push_token = $1', [token]);
      }
    } else {
      console.log(`ℹ️ [PUSH] Nessun token registrato per l'utente ${userId}`);
    }
    
    return notification;
  } catch (err) {
    console.error('❌ [NOTIFY_SERVICE] Errore critico:', err);
    throw err;
  }
};