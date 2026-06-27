import { pool } from '../../db/db.js';
import { sendPush } from './push.service.js'; 
import { getIO } from '../../socket.js';

/**
 * Servizio centralizzato per l'invio di notifiche
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
    // 3. PUSH NOTIFICATION
    // =========================
    const tokenRes = await pool.query(
      'SELECT push_token FROM utente_push_tokens WHERE user_id = $1 LIMIT 1',
      [userId]
    );

    if (tokenRes.rows.length === 0) {
      console.log(`ℹ️ [PUSH] No token for user ${userId}`);
      return notification;
    }

    const token = tokenRes.rows[0].push_token;

    console.log("📨 [PUSH] Sending to token:", token);
    console.log("📨 [PUSH] Title:", title);
    console.log("📨 [PUSH] Message:", message);

    // =========================
    // SEND PUSH
    // =========================
    let pushResult;

    try {
      pushResult = await sendPush(
        token,
        title,
        message,
        { ...data, notificationId: notification.id }
      );

      console.log("📤 [PUSH RESULT RAW]:", JSON.stringify(pushResult, null, 2));
    } catch (pushErr) {
      console.error("❌ [PUSH SEND ERROR]", pushErr);
      return notification;
    }

    // =========================
    // 4. RESPONSE VALIDATION
    // =========================
    const ticket = pushResult?.data?.[0];

    if (!ticket) {
      console.error("❌ [PUSH] Invalid Expo response (no ticket)");
      return notification;
    }

    console.log("📦 [PUSH TICKET]:", ticket);

    if (ticket.status === 'error') {
      console.error("❌ [PUSH ERROR]", ticket);

      if (ticket?.details?.error === 'DeviceNotRegistered') {
        console.warn("🗑️ [PUSH] Removing invalid token for user:", userId);

        await pool.query(
          'DELETE FROM utente_push_tokens WHERE push_token = $1',
          [token]
        );
      }
    }

    if (ticket.status === 'ok') {
      console.log("✅ [PUSH] Sent successfully. ID:", ticket.id);
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