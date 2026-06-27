import { pool } from '../../db/db.js';
import { sendPush } from './push.service.js';
import { getIO } from '../../socket.js';

/**
 * Servizio centralizzato per notifiche (FCM)
 */
export const notifyUser = async (
  userId,
  { type, title = 'Nuova Notifica', message, role, data = {} }
) => {
  try {
    // =========================
    // 1. SAVE NOTIFICATION DB
    // =========================
    const result = await pool.query(
      `INSERT INTO notifications(user_id, type, message, seen, created_at) 
       VALUES ($1, $2, $3, false, NOW()) RETURNING *`,
      [userId, type, message]
    );

    const notification = result.rows[0];
    console.log("📝 [NOTIFY] Saved notification:", notification.id);

    // =========================
    // 2. SOCKET REALTIME
    // =========================
    try {
      const io = getIO();
      const room = `${role === 'driver' ? 'autista' : role}_${userId}`;

      io.to(room).emit("new_notification", {
        ...notification,
        sentAt: Date.now(),
      });

      console.log(`🚀 [SOCKET] Sent to room: ${room}`);
    } catch (e) {
      console.warn("⚠️ [SOCKET ERROR]", e.message);
    }

    // =========================
    // 3. GET PUSH TOKEN
    // =========================
    // CORRETTO: nome colonna da 'fcm_token' a 'push_token'
    const tokenRes = await pool.query(
      `SELECT push_token FROM utente_push_tokens WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    if (tokenRes.rows.length === 0) {
      console.log(`ℹ️ [FCM] No token for user ${userId}`);
      return notification;
    }

    // CORRETTO: accesso alla proprietà corretta
    const fcmToken = tokenRes.rows[0].push_token;
    console.log("📨 [FCM] Sending to token:", fcmToken ? "Presente" : "Vuoto");

    if (!fcmToken) return notification;

    // =========================
    // 4. SEND PUSH VIA FCM
    // =========================
    try {
      const pushResult = await sendPush(
        fcmToken,
        title,
        message,
        {
          ...data,
          notificationId: notification.id.toString(),
          type,
        }
      );

      console.log("📤 [FCM RESULT]:", pushResult?.success ? "Success" : "Failed");
    } catch (pushErr) {
      console.error("❌ [FCM SEND ERROR]", pushErr.message);
      // Non blocchiamo la notifica se fallisce solo il push
    }

    return notification;

  } catch (err) {
    console.error('❌ [NOTIFY_SERVICE] Critical error:', err);
    throw err;
  }
};