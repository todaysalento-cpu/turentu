import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";

let io;

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
  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("NO_TOKEN"));
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
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
      const chatRoom = `chat_${Number(corsa_id)}_${Number(cliente_id)}`;
      socket.join(chatRoom);
      log("JOIN_CHAT", { chatRoom, userId });
    });

    socket.on("send_message", async (payload) => {
      try {
        const cId = Number(payload.corsa_id);
        const clId = Number(payload.cliente_id);
        
        const msgRes = await pool.query(
          `INSERT INTO messaggi (corsa_id, cliente_id, sender_id, testo, audio_url, tipo_messaggio, client_msg_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *, EXTRACT(EPOCH FROM created_at) * 1000 as created_at_ms`,
          [cId, clId, userId, payload.text, payload.audio_url, payload.tipo_messaggio || 'text', payload.client_msg_id]
        );

        const threadRes = await pool.query(`SELECT driver_id FROM chat_threads WHERE corsa_id=$1 AND cliente_id=$2`, [cId, clId]);
        
        io.to(`chat_${cId}_${clId}`).emit("new_message", { ...msgRes.rows[0], corsa_id: cId, cliente_id: clId });
        
        const targetRole = role === "cliente" ? "autista" : "cliente";
        const recipientId = role === "cliente" ? threadRes.rows[0]?.driver_id : clId;
        
        if (recipientId) {
          io.to(`${targetRole}_${Number(recipientId)}`).emit("unread_count_updated", { 
            corsa_id: cId, 
            cliente_id: clId, 
            increment: 1 
          });
        }
      } catch (err) {
        log("SEND_MESSAGE_FAILED", { error: err.message });
      }
    });

    socket.on("disconnect", (reason) => {
      log("SOCKET_DISCONNECTED", { userId, reason });
    });
  });
};