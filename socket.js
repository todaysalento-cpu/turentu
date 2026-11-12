import { accountExists } from './middleware/account-exists.js';
import jwt from "jsonwebtoken";
import { JWT_SECRET } from './config/security.js';
import { pool } from "./db/db.js";
import { canAccessChat } from "./services/chat/chat-access.service.js";

let io;

export function disconnectAccountSockets(id, role) {
  io?.in(`${role}_${id}`).disconnectSockets(true);
}

export const getIO = () => {
  if (!io) throw new Error("Socket.io non inizializzato!");
  return io;
};

const log = (label, data = {}) =>
  console.log(JSON.stringify({ 
    time: new Date().toISOString(), 
    label, 
    ...data 
  }, null, 2));

/* ================= NOTIFICATIONS ================= */
export const sendNotification = async ({ userId, role, notification }) => {
  if (!io) return;
  
  // Normalizzazione rigorosa per invio
  const uId = Number(userId);
  const r = String(role).toLowerCase() === 'driver' ? 'autista' : String(role).toLowerCase();
  const room = `${r}_${uId}`;
  
  log("SOCKET_SENDING_NOTIFICATION", { 
    room, 
    notificationId: notification?.id,
    targetUserId: uId
  });
  
  io.to(room).emit("new_notification", { ...notification, sentAt: Date.now() });
};

/* ================= SOCKET SETUP ================= */
export const setupSocket = (ioServer) => {
  io = ioServer;

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("NO_TOKEN"));
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (!(await accountExists(decoded.id))) return next(new Error('ACCOUNT_UNAVAILABLE'));
      
      // Normalizzazione ruoli e ID
      let rawRole = String(decoded.role || decoded.tipo || "cliente").toLowerCase();
      const finalRole = rawRole === 'driver' ? 'autista' : rawRole;
      
      socket.user = { 
        id: Number(decoded.id), 
        role: finalRole 
      };
      
      next();
    } catch (err) {
      log("SOCKET_AUTH_ERROR", { error: err.message });
      next(new Error("JWT_INVALID"));
    }
  });

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;
    const room = `${role}_${userId}`;
    
    socket.join(room);
    log("SOCKET_CONNECTION", { userId, role, room, socketId: socket.id });

    socket.on("force_join_room", () => {
      socket.join(room);
      log("SOCKET_FORCED_JOIN", { userId, role, room, socketId: socket.id });
    });

    /* ================= CHAT LOGIC ================= */
    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      const cId = Number(corsa_id), clId = Number(cliente_id);
      if (!(await canAccessChat(pool, cId, clId, userId))) return;
      const chatRoom = `chat_${cId}_${clId}`;
      socket.join(chatRoom);
      log("JOIN_CHAT", { chatRoom, userId });
    });

    socket.on("message_delivered", async (payload) => {
      try {
        const messageId = Number(payload?.message_id);
        const cId = Number(payload?.corsa_id);
        const clId = Number(payload?.cliente_id);
        if (![messageId, cId, clId].every(x => Number.isSafeInteger(x) && x > 0)) return;
        if (!(await canAccessChat(pool, cId, clId, userId))) return;

        const result = await pool.query(
          `INSERT INTO message_receipts (message_id, user_id, delivered_at)
           SELECT m.id, $4, NOW() FROM messaggi m
           WHERE m.id = $1 AND m.corsa_id = $2 AND m.cliente_id = $3 AND m.sender_id <> $4
           ON CONFLICT (message_id, user_id)
           DO UPDATE SET delivered_at = COALESCE(message_receipts.delivered_at, EXCLUDED.delivered_at)
           RETURNING message_id`,
          [messageId, cId, clId, userId]
        );
        if (!result.rows.length) return;

        io.to(`chat_${cId}_${clId}`).emit("message_delivered", {
          corsa_id: cId, cliente_id: clId, message_ids: [String(messageId)]
        });
      } catch (error) {
        log("MESSAGE_DELIVERED_FAILED", { userId, error: error.message });
      }
    });

    socket.on("send_message", async (payload, ack) => {
      const reply = (data) => {
        if (typeof ack === "function") ack(data);
      };

      try {
        const cId = Number(payload?.corsa_id);
        const clId = Number(payload?.cliente_id);
        const clientMsgId = String(payload?.client_msg_id || "").trim();

        if (
          !Number.isSafeInteger(cId) || cId <= 0 ||
          !Number.isSafeInteger(clId) || clId <= 0 ||
          !clientMsgId || clientMsgId.length > 200
        ) {
          return reply({ ok: false, error: "INVALID_MESSAGE_DATA" });
        }

        if (!(await canAccessChat(pool, cId, clId, userId))) {
          log("SEND_MESSAGE_FORBIDDEN", { userId, cId, clId });
          return reply({ ok: false, error: "CHAT_ACCESS_DENIED" });
        }

        const msgRes = await pool.query(
          `INSERT INTO messaggi
            (corsa_id, cliente_id, sender_id, testo, audio_url, tipo_messaggio, client_msg_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (client_msg_id) DO NOTHING
           RETURNING *, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms`,
          [
            cId, clId, userId, payload.text,
            payload.audio_url, payload.tipo_messaggio || "text",
            clientMsgId
          ]
        );

        const inserted = msgRes.rows.length > 0;
        let message = msgRes.rows[0];

        if (!inserted) {
          const existing = await pool.query(
            `SELECT *, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms
             FROM messaggi
             WHERE client_msg_id = $1
               AND corsa_id = $2
               AND cliente_id = $3
               AND sender_id = $4`,
            [clientMsgId, cId, clId, userId]
          );

          if (!existing.rows.length) {
            return reply({ ok: false, error: "MESSAGE_ID_CONFLICT" });
          }

          message = existing.rows[0];
        }

        const socketMessage = {
          ...message,
          corsa_id: cId,
          cliente_id: clId
        };

        reply({
          ok: true,
          message: socketMessage,
          duplicate: !inserted
        });

        if (!inserted) return;

        io.to(`chat_${cId}_${clId}`)
          .emit("new_message", socketMessage);

        const threadRes = await pool.query(
          "SELECT driver_id FROM chat_threads WHERE corsa_id=$1 AND cliente_id=$2",
          [cId, clId]
        );

        const targetRole = role === "cliente" ? "autista" : "cliente";
        const recipientId =
          role === "cliente" ? threadRes.rows[0]?.driver_id : clId;

        if (recipientId) {
          io.to(`${targetRole}_${Number(recipientId)}`)
            .emit("unread_count_updated", {
              corsa_id: cId,
              cliente_id: clId,
              increment: 1
            });
        }
      } catch (err) {
        log("SEND_MESSAGE_FAILED", { userId, error: err.message });
        reply({ ok: false, error: "MESSAGE_SEND_FAILED" });
      }
    });

    socket.on("disconnect", (reason) => {
      log("SOCKET_DISCONNECTED", { userId, reason });
    });
  });
};
