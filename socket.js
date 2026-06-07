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
  
  const room = `${role.toLowerCase()}_${userId}`;
  
  // Ispezione avanzata
  const rooms = io.sockets.adapter.rooms;
  const roomSet = rooms.get(room);
  
  log("SOCKET_SENDING_NOTIFICATION", { 
    room, 
    notificationId: notification.id,
    roomExists: !!roomSet,
    clientsInRoom: roomSet ? roomSet.size : 0,
    allActiveRooms: Array.from(rooms.keys()) // Debug utile per vedere se il nome stanza differisce
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
    const room = `${role.toLowerCase()}_${userId}`;
    
    // Join forzato
    socket.join(room);
    
    log("SOCKET_CONNECTION", { 
      userId, 
      role, 
      room, 
      socketId: socket.id,
      isMember: socket.rooms.has(room) 
    });

    // Debug: Permetti al client di richiedere il proprio stato
    socket.on("debug_my_status", () => {
      socket.emit("my_status", { 
        userId, 
        currentRooms: Array.from(socket.rooms) 
      });
    });

    /* ================= JOIN CHAT ================= */
    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      const chatRoom = `chat_${Number(corsa_id)}_${Number(cliente_id)}`;
      socket.join(chatRoom);
      
      try {
        const { rows } = await pool.query(
          `SELECT m.id, m.sender_id, m.testo, m.audio_url, m.tipo_messaggio, 
                  EXTRACT(EPOCH FROM m.created_at) * 1000 as created_at_ms
           FROM messaggi m WHERE m.corsa_id = $1 AND m.cliente_id = $2 ORDER BY m.created_at ASC`,
          [Number(corsa_id), Number(cliente_id)]
        );
        socket.emit("init_chat", { messages: rows });
      } catch (err) {
        log("INIT_CHAT_FAILED", { error: err.message });
      }
    });

    /* ================= SEND MESSAGE ================= */
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
        
        // Emette messaggio nella stanza chat
        io.to(`chat_${cId}_${clId}`).emit("new_message", { ...msgRes.rows[0], corsa_id: cId, cliente_id: clId });
        
        // Aggiorna notifica lettura
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