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

/* ================= NOTIFICATIONS ================= */

export const sendNotification = ({ userId, role, notification }) => {
  if (!io || !userId || !role || !notification) return;

  const room = `${role}_${userId}`;

  io.to(room).emit("new_notification", {
    ...notification,
    sentAt: Date.now(),
  });

  log("NOTIFICATION_SENT", { room, userId, role });
};

/* ================= SOCKET SETUP ================= */

export const setupSocket = (ioServer) => {
  io = ioServer;

  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  /* ================= AUTH ================= */

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("NO_TOKEN"));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);

      socket.user = {
        id: decoded.id,
        role: (decoded.role || "cliente").toLowerCase(),
      };

      log("AUTH_OK", socket.user);

      next();
    } catch (err) {
      log("AUTH_FAILED");
      next(new Error("JWT_INVALID"));
    }
  });

  /* ================= CONNECTION ================= */

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;

    socket.join(`${role}_${userId}`);

    log("SOCKET_CONNECTED", { userId, role });

    /* =====================================================
       JOIN CHAT
    ===================================================== */

    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      const cId = Number(corsa_id);
      const clId = Number(cliente_id);

      if (!cId || !clId) return;

      const room = `chat_${cId}_${clId}`;
      socket.join(room);

      log("JOIN_CHAT", { userId, cId, clId });

      try {
        /* 
          RIFINITURA LOGICA: Esattamente come nell'HTTP, incrociamo le ricevute.
          Se il messaggio l'ho inviato io, guardo se lo ha letto l'altro utente.
          Se il messaggio è dell'altro utente, guardo se lo ho letto io.
        */
        const { rows } = await pool.query(
          `
          SELECT 
            m.id,
            m.corsa_id,
            m.cliente_id,
            m.sender_id,
            m.testo AS text,
            m.client_msg_id,
            m.created_at,
            mr.delivered_at,
            mr.read_at
          FROM messaggi m
          LEFT JOIN message_receipts mr
            ON mr.message_id = m.id
           AND mr.device_id = 'api'
           AND mr.user_id = CASE 
             WHEN m.sender_id = $3 THEN (
               CASE WHEN $3 = m.cliente_id THEN (SELECT driver_id FROM chat_threads WHERE corsa_id = $1 AND cliente_id = $2 LIMIT 1)
               ELSE m.cliente_id END
             )
             ELSE $3
           END
          WHERE m.corsa_id = $1
            AND m.cliente_id = $2
          ORDER BY m.created_at ASC
          `,
          [cId, clId, userId]
        );

        const messages = rows.map((m) => ({
          id: String(m.id),
          corsa_id: cId,
          cliente_id: clId,
          sender_id: Number(m.sender_id),
          text: m.text ?? "",
          client_msg_id: m.client_msg_id ?? null,
          created_at: Number(new Date(m.created_at)),
          status: {
            sent: true,
            delivered: Boolean(m.delivered_at) || Boolean(m.read_at),
            read: Boolean(m.read_at),
          },
        }));

        socket.emit("init_chat", {
          corsa_id: cId,
          cliente_id: clId,
          messages,
        });

        log("INIT_CHAT_SENT", { room, count: messages.length });
      } catch (err) {
        log("INIT_CHAT_FAILED", { error: err.message });
      }
    });

    /* =====================================================
       SEND MESSAGE
    ===================================================== */

    socket.on("send_message", async (payload) => {
      try {
        const { corsa_id, cliente_id, text, client_msg_id } = payload;

        const cId = Number(corsa_id);
        const clId = Number(cliente_id);

        const trimmed = text?.trim();
        if (!trimmed) return;

        const threadRes = await pool.query(
          `SELECT driver_id FROM chat_threads WHERE corsa_id=$1 AND cliente_id=$2`,
          [cId, clId]
        );

        const thread = threadRes.rows[0];
        if (!thread) return;

        const msgKey = client_msg_id || crypto.randomUUID();

        const msgRes = await pool.query(
          `
          INSERT INTO messaggi (
            corsa_id, cliente_id, sender_id, testo, client_msg_id, created_at
          )
          VALUES ($1,$2,$3,$4,$5,NOW())
          RETURNING *
          `,
          [cId, clId, userId, trimmed, msgKey]
        );

        const msg = msgRes.rows[0];

        const recipientId = role === "cliente" ? thread.driver_id : clId;
        const targetRole = role === "cliente" ? "autista" : "cliente";

        const room = `chat_${cId}_${clId}`;
        const recipientRoom = `${targetRole}_${recipientId}`;

        const isOnline = io.sockets.adapter.rooms.get(recipientRoom)?.size > 0;

        /* ================= EMIT MESSAGE ================= */

        io.to(room).emit("new_message", {
          id: String(msg.id),
          corsa_id: cId,
          cliente_id: clId,
          sender_id: userId,
          text: trimmed,
          client_msg_id: msgKey,
          created_at: Number(new Date(msg.created_at)),
          status: {
            sent: true,
            delivered: isOnline, 
            read: false,
          },
        });

        /* ================= RECEIPT ================= */

        if (isOnline) {
          await pool.query(
            `
            INSERT INTO message_receipts (message_id, user_id, device_id, delivered_at)
            VALUES ($1, $2, 'api', NOW())
            ON CONFLICT (message_id, user_id, device_id) DO NOTHING
            `,
            [msg.id, recipientId]
          );

          const deliveryPayload = {
            message_id: String(msg.id),
            corsa_id: cId,
            cliente_id: clId,
            delivered_at: Date.now(),
          };

          io.to(room).to(recipientRoom).emit("message_delivered", deliveryPayload);
          log("DELIVERED_REALTIME", { messageId: msg.id, room });
        }
      } catch (err) {
        log("SEND_FAILED", { error: err.message });
      }
    });

    /* =====================================================
       MARK AS READ
    ===================================================== */

    socket.on("mark_as_read", async ({ corsa_id, cliente_id, message_ids = [] }) => {
      try {
        const cId = Number(corsa_id);
        const clId = Number(cliente_id);
        const ids = message_ids.map(Number).filter(Number.isInteger);
        
        if (!ids.length || !cId || !clId) return;

        const result = await pool.query(
          `
          INSERT INTO message_receipts (message_id, user_id, device_id, read_at, delivered_at)
          SELECT unnest($1::int[]), $2, 'api', NOW(), NOW()
          ON CONFLICT (message_id, user_id, device_id) 
          DO UPDATE SET 
            read_at = COALESCE(message_receipts.read_at, NOW()),
            delivered_at = COALESCE(message_receipts.delivered_at, NOW())
          WHERE message_receipts.read_at IS NULL
          RETURNING message_id
          `,
          [ids, userId]
        );

        const updated = result.rows.map((r) => String(r.message_id));
        if (!updated.length) return;

        const room = `chat_${cId}_${clId}`;
        
        const threadRes = await pool.query(
          `SELECT driver_id FROM chat_threads WHERE corsa_id=$1 AND cliente_id=$2`,
          [cId, clId]
        );
        const thread = threadRes.rows[0];

        if (thread) {
          const recipientId = role === "cliente" ? thread.driver_id : clId;
          const targetRole = role === "cliente" ? "autista" : "cliente";
          const recipientRoom = `${targetRole}_${recipientId}`;

          io.to(room).to(recipientRoom).emit("message_read", {
            message_ids: updated,
            corsa_id: cId,
            cliente_id: clId,
            reader_id: userId,
            read_at: Date.now(),
          });
        }

        log("READ_UPDATED", { userId, count: updated.length, room });
      } catch (err) {
        log("READ_FAILED", { error: err.message });
      }
    });

    /* ================= DISCONNECT ================= */

    socket.on("disconnect", () => {
      log("DISCONNECT", { userId });
    });
  });
};