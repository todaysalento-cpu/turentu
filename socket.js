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
  console.log(
    JSON.stringify(
      {
        time: new Date().toISOString(),
        label,
        ...data,
      },
      null,
      2
    )
  );

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
      log("AUTH_OK", socket.user);
      next();
    } catch (err) {
      log("AUTH_FAILED");
      next(new Error("JWT_INVALID"));
    }
  });

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;
    socket.join(`${role}_${userId}`);
    log("SOCKET_CONNECTED", { userId, role });

    /* ================= JOIN CHAT ================= */
    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      const cId = Number(corsa_id);
      const clId = Number(cliente_id);
      if (!cId || !clId) return;

      const room = `chat_${cId}_${clId}`;
      socket.join(room);

      try {
        const { rows } = await pool.query(
          `SELECT m.id, m.sender_id, m.testo AS text, m.created_at,
                  MAX(mr.delivered_at) as delivered_at,
                  MAX(mr.read_at) as read_at
           FROM messaggi m
           LEFT JOIN message_receipts mr ON mr.message_id = m.id AND mr.user_id = $3
           WHERE m.corsa_id = $1 AND m.cliente_id = $2
           GROUP BY m.id
           ORDER BY m.created_at ASC`,
          [cId, clId, userId]
        );

        // DEBUG: Vediamo cosa sta recuperando il DB
        log("DEBUG_JOIN_CHAT_FETCH", { 
          userId, 
          msgCount: rows.length, 
          firstMsgReadAt: rows[0]?.read_at 
        });

        const messages = rows.map((m) => ({
          id: String(m.id),
          corsa_id: cId,
          cliente_id: clId,
          sender_id: Number(m.sender_id),
          text: m.text ?? "",
          created_at: Number(new Date(m.created_at)),
          status: {
            sent: true,
            delivered: Boolean(m.delivered_at) || Boolean(m.read_at),
            read: Boolean(m.read_at),
          },
        }));

        socket.emit("init_chat", { corsa_id: cId, cliente_id: clId, messages });
        log("INIT_CHAT_SENT", { room, msgCount: messages.length });
      } catch (err) {
        log("INIT_CHAT_FAILED", { error: err.message });
      }
    });

    /* ================= SEND MESSAGE ================= */
    socket.on("send_message", async (payload) => {
      try {
        const { corsa_id, cliente_id, text, client_msg_id } = payload;
        const msgRes = await pool.query(
          `INSERT INTO messaggi (corsa_id, cliente_id, sender_id, testo, client_msg_id, created_at)
           VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
          [Number(corsa_id), Number(cliente_id), userId, text.trim(), client_msg_id || crypto.randomUUID()]
        );
        
        log("MESSAGE_SENT_TO_DB", { msgId: msgRes.rows[0].id, userId });
        // ... (resto della logica di emissione)
      } catch (err) {
        log("SEND_FAILED", { error: err.message });
      }
    });

    /* ================= MARK AS READ ================= */
    socket.on("mark_as_read", async ({ corsa_id, cliente_id, message_ids = [] }) => {
      try {
        const ids = message_ids.map(Number).filter(Number.isInteger);
        log("DEBUG_MARK_AS_READ_RECEIVED", { userId, ids });

        const result = await pool.query(
          `INSERT INTO message_receipts (message_id, user_id, device_id, read_at, delivered_at)
           SELECT unnest($1::int[]), $2, 'api', NOW(), NOW()
           ON CONFLICT (message_id, user_id, device_id) 
           DO UPDATE SET read_at = NOW(), delivered_at = NOW()
           WHERE message_receipts.read_at IS NULL
           RETURNING message_id`,
          [ids, userId]
        );

        log("DEBUG_MARK_AS_READ_UPDATED_DB", { rowCount: result.rowCount, ids: result.rows });

        if (result.rowCount > 0) {
          io.to(`chat_${corsa_id}_${cliente_id}`).emit("message_read", {
            message_ids: result.rows.map(r => String(r.message_id)),
            corsa_id,
            cliente_id
          });
        }
      } catch (err) {
        log("READ_FAILED", { error: err.message });
      }
    });

    socket.on("disconnect", () => log("DISCONNECT", { userId }));
  });
};