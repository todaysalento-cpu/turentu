import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import crypto from "crypto";

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
  
  // Normalizzazione rigorosa: tutto in minuscolo
  const room = `${String(role).toLowerCase()}_${userId}`;
  
  // Debug: Ispezione profonda dello stato delle stanze
  const roomSet = io.sockets.adapter.rooms.get(room);
  const isRoomActive = !!roomSet;
  const clientsCount = isRoomActive ? roomSet.size : 0;
  
  log("SOCKET_SENDING_NOTIFICATION", { 
    room, 
    notificationId: notification.id,
    roomExists: isRoomActive,
    clientsConnected: clientsCount
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
      socket.user = { 
        id: Number(decoded.id), 
        role: (decoded.role || "cliente").toLowerCase() 
      };
      next();
    } catch (err) {
      next(new Error("JWT_INVALID"));
    }
  });

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;
    const room = `${role}_${userId}`;
    
    // Join alla connessione
    socket.join(room);
    log("SOCKET_CONNECTION", { userId, role, room, socketId: socket.id });

    // Meccanismo di auto-ripristino stanza (chiamabile dal client)
    socket.on("force_join_room", () => {
      socket.join(room);
      log("SOCKET_FORCED_JOIN", { userId, room });
    });

    /* ================= CHAT LOGIC ================= */
    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      const chatRoom = `chat_${Number(corsa_id)}_${Number(cliente_id)}`;
      socket.join(chatRoom);
      log("JOIN_CHAT", { room: chatRoom, userId });
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
        
        // Emette messaggio
        io.to(`chat_${cId}_${clId}`).emit("new_message", { ...msgRes.rows[0], corsa_id: cId, cliente_id: clId });
        
        const targetRole = role === "cliente" ? "autista" : "cliente";
        const recipientId = role === "cliente" ? threadRes.rows[0]?.driver_id : clId;
        
        if (recipientId) {
          io.to(`${targetRole}_${recipientId}`).emit("unread_count_updated", { corsa_id: cId, cliente_id: clId, increment: 1 });
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