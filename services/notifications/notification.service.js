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
    // 3. GET FCM TOKEN (NOT EXPO)
    // =========================
    const tokenRes = await pool.query(
      `SELECT fcm_token FROM utente_push_tokens WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    if (tokenRes.rows.length === 0) {
      console.log(`ℹ️ [FCM] No token for user ${userId}`);
      return notification;
    }

    const fcmToken = tokenRes.rows[0].fcm_token;

    console.log("📨 [FCM] Sending to token:", fcmToken);

    // =========================
    // 4. SEND PUSH VIA FCM
    // =========================
    let pushResult;

    try {
      pushResult = await sendPush(
        fcmToken,
        title,
        message,
        {
          ...data,
          notificationId: notification.id,
          type,
        }
      );

      console.log("📤 [FCM RESULT RAW]:", JSON.stringify(pushResult, null, 2));
    } catch (pushErr) {
      console.error("❌ [FCM SEND ERROR]", pushErr);
      return notification;
    }

    // =========================
    // 5. RESPONSE HANDLING (FCM)
    // =========================
    const response = pushResult;

    if (!response) {
      console.error("❌ [FCM] Empty response");
      return notification;
    }

    console.log("📦 [FCM RESPONSE]:", response);

    // Firebase success format: { name: "projects/.../messages/..." }
    if (response.name) {
      console.log("✅ [FCM] Sent successfully:", response.name);
    } else {
      console.warn("⚠️ [FCM] Unexpected response format:", response);
    }

    // =========================
    // RETURN
    // =========================
    return notification;

  } catch (err) {
    console.error('❌ [NOTIFY_SERVICE] Critical error:', err);
    throw err;
  }
};