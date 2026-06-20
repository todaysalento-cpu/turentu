import { pool } from '../../db/db.js';
import { sendPush } from './push.service.js'; 
import { getIO } from '../../socket.js';

/**
 * Servizio centralizzato per l'invio di notifiche
 */
export const notifyUser = async (userId, { type, message, role, data = {} }) => {
  try {
    // Risoluzione ID: converte "ADMIN_ID" in un ID numerico (es. 1) per la compatibilità col DB
    // Sostituisci il numero 1 con l'ID reale del tuo amministratore nel database
    const targetUserId = userId === 'ADMIN_ID' ? 1 : userId;

    // 1. SALVATAGGIO NEL DATABASE
    const result = await pool.query(
      `INSERT INTO notifications(user_id, type, message, seen, created_at) 
       VALUES ($1, $2, $3, false, NOW()) RETURNING *`,
      [targetUserId, type, message]
    );
    const notification = result.rows[0];

    // 2. INVIO VIA SOCKET (Real-time per app attiva)
    try {
      const io = getIO();
      // Normalizzazione della room: utilizziamo l'ID originale (stringa o numero) per mantenere coerenza
      const room = `${role === 'driver' ? 'autista' : role}_${userId}`;
      io.to(room).emit("new_notification", { ...notification, sentAt: Date.now() });
      console.log(`🚀 [SOCKET] Notifica inviata in stanza: ${room}`);
    } catch (e) {
      console.warn("⚠️ [SOCKET] Socket non disponibile:", e.message);
    }

    // 3. INVIO PUSH (Background per app chiusa)
    const tokenRes = await pool.query(
      'SELECT push_token FROM utente_push_tokens WHERE user_id = $1 LIMIT 1', 
      [targetUserId]
    );

    if (tokenRes.rows.length > 0) {
      const token = tokenRes.rows[0].push_token;
      await sendPush(
        token, 
        'Nuova Notifica', 
        message, 
        { ...data, notificationId: notification.id }
      );
      console.log(`📲 [PUSH] Notifica inviata all'utente ${targetUserId}`);
    } else {
      console.log(`ℹ️ [PUSH] Nessun token registrato per l'utente ${targetUserId}`);
    }
    
    return notification;
  } catch (err) {
    console.error('❌ [NOTIFY_SERVICE] Errore critico:', err);
    throw err;
  }
};