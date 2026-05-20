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

/* ================= SOCKET SETUP ================= */
export const setupSocket = (ioServer) => {
  io = ioServer;
  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("NO_TOKEN"));
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = { id: decoded.id, role: (decoded.role || "cliente").toLowerCase() };
      next();
    } catch (err) {
      next(new Error("JWT_INVALID"));
    }
  });

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;
    socket.join(`${role}_${userId}`);

    /* ================= JOIN CHAT ================= */
    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      const cId = Number(corsa_id);
      const clId = Number(cliente_id);
      if (!cId || !clId) return;

      socket.join(`chat_${cId}_${clId}`);

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
          sender_id: Number(m.sender_id),
          text: m.text ?? null,
          audio_url: m.audio_url ?? null,
          tipo_messaggio: m.tipo_messaggio ?? 'text',
          client_msg_id: m.client_msg_id ?? null,
          created_at: Number(m.created_at_ms),
          status: { sent: true, delivered: Boolean(m.delivered_at) || Boolean(m.read_at), read: Boolean(m.read_at) },
        }));

        socket.emit("init_chat", { corsa_id: cId, cliente_id: clId, messages });
      } catch (err) {
        log("INIT_CHAT_FAILED", { error: err.message });
      }
    });

    /* ================= SEND MESSAGE (Supporto Audio) ================= */
    socket.on("send_message", async (payload) => {
      try {
        const { corsa_id, cliente_id, text, audio_url, tipo_messaggio, client_msg_id } = payload;
        const cId = Number(corsa_id);
        const clId = Number(cliente_id);
        
        // Verifica contenuto valido
        if (!text && !audio_url) return;

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
          [cId, clId, userId, text || null, audio_url || null, msgType, msgKey]
        );

        const msg = msgRes.rows[0];
        const recipientId = role === "cliente" ? thread.driver_id : clId;
        const targetRole = role === "cliente" ? "autista" : "cliente";
        const recipientRoom = `${targetRole}_${recipientId}`;
        const isOnline = io.sockets.adapter.rooms.get(recipientRoom)?.size > 0;

        // Emetti il nuovo messaggio
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

        // Notifica incremento contatore
        io.to(recipientRoom).emit("unread_count_updated", { corsa_id: cId, cliente_id: clId, increment: 1 });
      } catch (err) {
        log("SEND_FAILED", { error: err.message });
      }
    });

    // ... (resta invariato il resto del file: mark_as_read, disconnect) ...
  });
};