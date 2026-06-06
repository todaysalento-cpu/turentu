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
  console.log(JSON.stringify({ time: new Date().toISOString(), label, ...data }, null, 2));

/* ================= NOTIFICATIONS ================= */
export const sendNotification = ({ userId, role, notification }) => {
  if (!io || !userId || !role || !notification) return;
  
  const cleanRole = role.toLowerCase();
  const room = `${cleanRole}_${userId}`;
  
  // LOG DI DIAGNOSTICA AVANZATA
  const clients = io.sockets.adapter.rooms.get(room);
  if (!clients || clients.size === 0) {
    log("NOTIFICATION_LOST", { 
      room, 
      userId, 
      reason: "No clients in room - Client disconnesso o mancata iscrizione alla stanza",
      activeRooms: Array.from(io.sockets.adapter.rooms.keys()).filter(r => r.includes(userId))
    });
  } else {
    log("NOTIFICATION_SENT", { room, userId, role: cleanRole, targetClients: clients.size });
  }

  io.to(room).emit("new_notification", { ...notification, sentAt: Date.now() });
};

/* ================= SOCKET SETUP ================= */
export const setupSocket = (ioServer) => {
  io = ioServer;
  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      log("AUTH_FAILED", { error: "NO_TOKEN" });
      return next(new Error("NO_TOKEN"));
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = { id: decoded.id, role: (decoded.role || "cliente").toLowerCase() };
      next();
    } catch (err) {
      log("AUTH_FAILED", { error: "JWT_INVALID" });
      next(new Error("JWT_INVALID"));
    }
  });

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;
    const room = `${role}_${userId}`;
    
    // JOIN AUTOMATICO
    socket.join(room);
    
    // LOG DI VERIFICA CONNESSIONE
    const allRooms = Array.from(socket.rooms);
    log("SOCKET_CONNECTED", { userId, role, room, currentSocketRooms: allRooms });

    /* ================= JOIN CHAT ================= */
    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      const cId = Number(corsa_id);
      const clId = Number(cliente_id);
      if (!cId || !clId) return;

      const chatRoom = `chat_${cId}_${clId}`;
      socket.join(chatRoom);
      log("JOINED_CHAT", { corsa_id: cId, cliente_id: clId, room: chatRoom });

      try {
        const { rows } = await pool.query(
          `SELECT m.id, m.sender_id, m.testo as text, m.audio_url, m.tipo_messaggio, 
                  m.client_msg_id, EXTRACT(EPOCH FROM m.created_at) * 1000 as created_at_ms,
                  MAX(mr.delivered_at) as delivered_at, MAX(mr.read_at) as read_at
           FROM messaggi m
           LEFT JOIN message_receipts mr ON mr.message_id = m.id
           WHERE m.corsa_id = $1 AND m.cliente_id = $2
           GROUP BY m.id
           ORDER BY m.created_at ASC`,
          [cId, clId]
        );

        const messages = rows.map((m) => ({
          id: String(m.id),
          corsa_id: cId,
          cliente_id: clId,
          sender_id: Number(m.sender_id),
          text: m.text ?? null,
          audio_url: m.audio_url ?? null,
          tipo_messaggio: m.tipo_messaggio ?? 'text',
          client_msg_id: m.client_msg_id ?? null,
          created_at: Number(m.created_at_ms),
          status: { 
            sent: true, 
            delivered: Boolean(m.delivered_at) || Boolean(m.read_at), 
            read: Boolean(m.read_at) 
          },
        }));

        socket.emit("init_chat", { corsa_id: cId, cliente_id: clId, messages });
      } catch (err) {
        log("INIT_CHAT_FAILED", { error: err.message });
      }
    });

    /* ================= SEND MESSAGE ================= */
    socket.on("send_message", async (payload) => {
      try {
        const { corsa_id, cliente_id, text, audio_url, tipo_messaggio, client_msg_id } = payload;
        const cId = Number(corsa_id);
        const clId = Number(cliente_id);
        
        if (!text?.trim() && !audio_url) return;

        const threadRes = await pool.query(
          `SELECT driver_id FROM chat_threads WHERE corsa_id=$1 AND cliente_id=$2`,
          [cId, clId]
        );
        const thread = threadRes.rows[0];
        if (!thread) return;

        const msgKey = client_msg_id || crypto.randomUUID();
        const msgType = tipo_messaggio || 'text';

        const msgRes = await pool.query(
          `INSERT INTO messaggi (corsa_id, cliente_id, sender_id, testo, audio_url, tipo_messaggio, client_msg_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           RETURNING *, EXTRACT(EPOCH FROM created_at) * 1000 as created_at_ms`,
          [cId, clId, userId, text?.trim() || null, audio_url || null, msgType, msgKey]
        );

        const msg = msgRes.rows[0];
        const recipientId = role === "cliente" ? thread.driver_id : clId;
        const targetRole = role === "cliente" ? "autista" : "cliente";
        const recipientRoom = `${targetRole}_${recipientId}`;
        
        const clients = io.sockets.adapter.rooms.get(recipientRoom);
        const isOnline = clients && clients.size > 0;

        io.to(`chat_${cId}_${clId}`).emit("new_message", {
          id: String(msg.id),
          corsa_id: cId,
          cliente_id: clId,
          sender_id: userId,
          text: msg.testo,
          audio_url: msg.audio_url,
          tipo_messaggio: msg.tipo_messaggio,
          client_msg_id: msgKey,
          created_at: Number(msg.created_at_ms),
          status: { sent: true, delivered: isOnline, read: false },
        });

        io.to(recipientRoom).emit("unread_count_updated", { corsa_id: cId, cliente_id: clId, increment: 1 });
      } catch (err) {
        log("SEND_FAILED", { error: err.message });
      }
    });

    /* ================= MARK AS READ ================= */
    socket.on("mark_as_read", async ({ corsa_id, cliente_id, message_ids = [] }) => {
      try {
        const cId = Number(corsa_id);
        const clId = Number(cliente_id);
        const ids = message_ids.map(Number).filter(Number.isInteger);
        if (!ids.length || !cId || !clId) return;

        const result = await pool.query(
          `INSERT INTO message_receipts (message_id, user_id, device_id, read_at, delivered_at)
           SELECT unnest($1::int[]), $2, 'api', NOW(), NOW()
           ON CONFLICT (message_id, user_id, device_id) 
           DO UPDATE SET read_at = COALESCE(message_receipts.read_at, NOW()), delivered_at = COALESCE(message_receipts.delivered_at, NOW())
           WHERE message_receipts.read_at IS NULL
           RETURNING message_id`,
          [ids, userId]
        );

        if (result.rowCount > 0) {
          io.to(`${role}_${userId}`).emit("unread_count_reset", { corsa_id: cId, cliente_id: clId });
          
          const threadRes = await pool.query(`SELECT driver_id FROM chat_threads WHERE corsa_id=$1 AND cliente_id=$2`, [cId, clId]);
          const thread = threadRes.rows[0];
          if (thread) {
            const recipientId = role === "cliente" ? thread.driver_id : clId;
            const targetRole = role === "cliente" ? "autista" : "cliente";
            io.to(`chat_${cId}_${clId}`).to(`${targetRole}_${recipientId}`).emit("message_read", {
              message_ids: result.rows.map(r => String(r.message_id)),
              corsa_id: cId,
              cliente_id: clId,
              reader_id: userId,
              read_at: Date.now(),
            });
          }
        }
      } catch (err) {
        log("READ_FAILED", { error: err.message });
      }
    });

    socket.on("disconnect", (reason) => log("DISCONNECT", { userId, reason }));
  });
};