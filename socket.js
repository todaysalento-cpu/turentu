import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import crypto from "crypto";

let io;

/* ================= IO ================= */
export const getIO = () => {
  if (!io) throw new Error("Socket.io non inizializzato!");
  return io;
};

/* ================= LOG ================= */
const log = (label, data = {}) =>
  console.log(JSON.stringify({ 
    time: new Date().toISOString(), 
    label, 
    ...data 
  }, null, 2));

/* ================= NOTIFICATIONS ================= */
export const sendNotification = async ({ userId, role, notification }) => {
  if (!io) {
    log("SOCKET_ERROR", { message: "IO non inizializzato durante notifica" });
    return;
  }
  if (!userId || !role || !notification) {
    log("SOCKET_ERROR", { message: "Parametri mancanti per notifica", userId, role });
    return;
  }
  
  const room = `${role.toLowerCase()}_${userId}`;
  log("SOCKET_SENDING_NOTIFICATION", { room, notificationId: notification.id });
  
  io.to(room).emit("new_notification", { ...notification, sentAt: Date.now() });
};

/* ================= SOCKET SETUP ================= */
export const setupSocket = (ioServer) => {
  io = ioServer;
  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  // Middleware di autenticazione
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      log("SOCKET_AUTH_ERROR", { message: "NO_TOKEN", ip: socket.handshake.address });
      return next(new Error("NO_TOKEN"));
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = { 
        id: Number(decoded.id), 
        role: (decoded.role || "cliente").toLowerCase() 
      };
      log("SOCKET_AUTH_SUCCESS", { userId: socket.user.id, role: socket.user.role });
      next();
    } catch (err) {
      log("SOCKET_AUTH_ERROR", { message: "JWT_INVALID", error: err.message });
      next(new Error("JWT_INVALID"));
    }
  });

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;
    const room = `${role}_${userId}`;
    
    socket.join(room);
    log("SOCKET_CONNECTION", { userId, role, room, socketId: socket.id });

    /* ================= JOIN CHAT ================= */
    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      const cId = Number(corsa_id);
      const clId = Number(cliente_id);
      
      if (!cId || isNaN(cId) || !clId || isNaN(clId)) {
        log("JOIN_CHAT_ERROR", { userId, message: "ID non validi", corsa_id, cliente_id });
        return;
      }

      const chatRoom = `chat_${cId}_${clId}`;
      socket.join(chatRoom);
      log("JOIN_CHAT", { room: chatRoom, userId });
      
      try {
        const { rows } = await pool.query(
          `SELECT m.id, m.sender_id, m.testo, m.audio_url, m.tipo_messaggio, 
                  EXTRACT(EPOCH FROM m.created_at) * 1000 as created_at_ms
           FROM messaggi m
           WHERE m.corsa_id = $1 AND m.cliente_id = $2
           ORDER BY m.created_at ASC`,
          [cId, clId]
        );
        socket.emit("init_chat", { corsa_id: cId, cliente_id: clId, messages: rows });
        log("INIT_CHAT_SUCCESS", { room: chatRoom, msgCount: rows.length });
      } catch (err) {
        log("INIT_CHAT_FAILED", { error: err.message, corsa_id: cId });
      }
    });

    /* ================= SEND MESSAGE ================= */
    socket.on("send_message", async (payload) => {
      log("SEND_MESSAGE_INIT", { userId, corsa_id: payload.corsa_id });
      try {
        const cId = Number(payload.corsa_id);
        const clId = Number(payload.cliente_id);
        if (isNaN(cId) || isNaN(clId)) throw new Error("INVALID_IDS");

        const msgKey = payload.client_msg_id || crypto.randomUUID();
        
        const msgRes = await pool.query(
          `INSERT INTO messaggi (corsa_id, cliente_id, sender_id, testo, audio_url, tipo_messaggio, client_msg_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *, EXTRACT(EPOCH FROM created_at) * 1000 as created_at_ms`,
          [cId, clId, userId, payload.text || null, payload.audio_url || null, payload.tipo_messaggio || 'text', msgKey]
        );

        const msg = msgRes.rows[0];
        const threadRes = await pool.query(`SELECT driver_id FROM chat_threads WHERE corsa_id=$1 AND cliente_id=$2`, [cId, clId]);
        
        const targetRole = role === "cliente" ? "autista" : "cliente";
        const recipientId = role === "cliente" ? threadRes.rows[0]?.driver_id : clId;
        
        // Emette messaggio
        io.to(`chat_${cId}_${clId}`).emit("new_message", { ...msg, corsa_id: cId, cliente_id: clId });
        log("SEND_MESSAGE_BROADCAST", { chatRoom: `chat_${cId}_${clId}` });
        
        if (recipientId) {
          const targetRoom = `${targetRole}_${recipientId}`;
          log("SENDING_UNREAD_UPDATE", { targetRoom });
          io.to(targetRoom).emit("unread_count_updated", { corsa_id: cId, cliente_id: clId, increment: 1 });
        }
      } catch (err) {
        log("SEND_MESSAGE_FAILED", { error: err.message });
      }
    });

    /* ================= MARK AS READ ================= */
    socket.on("mark_as_read", async ({ corsa_id, cliente_id, message_ids = [] }) => {
      try {
        const cId = Number(corsa_id);
        const clId = Number(cliente_id);
        const ids = message_ids.map(Number).filter(id => !isNaN(id));
        
        if (!ids.length || isNaN(cId) || isNaN(clId)) return;

        await pool.query(
          `INSERT INTO message_receipts (message_id, user_id, read_at)
           SELECT unnest($1::int[]), $2, NOW() ON CONFLICT DO NOTHING`,
          [ids, userId]
        );

        io.to(`${role}_${userId}`).emit("unread_count_reset", { corsa_id: cId, cliente_id: clId });
        log("MARK_AS_READ_SUCCESS", { userId, corsa_id, processedIds: ids.length });
      } catch (err) {
        log("READ_FAILED", { error: err.message });
      }
    });

    socket.on("disconnect", (reason) => {
      log("SOCKET_DISCONNECTED", { userId, socketId: socket.id, reason });
    });
  });
};