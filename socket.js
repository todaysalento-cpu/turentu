import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import crypto from "crypto";

let io;

/* ================= LOGGER ================= */

const log = (type, label, data = {}) => {
  console.log(
    JSON.stringify(
      {
        time: new Date().toISOString(),
        type,
        label,
        ...data,
      },
      null,
      2
    )
  );
};

/* ================= IO ================= */

export const getIO = () => {
  if (!io) throw new Error("Socket.io non inizializzato!");
  return io;
};

/* ================= NOTIFICATION ================= */

export const sendNotification = ({ userId, role, notification }) => {
  if (!io) return;
  io.to(`${role}_${userId}`).emit("new_notification", notification);
};

/* ================= SOCKET ================= */

export const setupSocket = (ioServer) => {
  io = ioServer;

  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  log("SOCKET", "INIT");

  /* ================= AUTH ================= */

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("NO_TOKEN"));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      decoded.role = decoded.role?.toLowerCase();
      socket.user = decoded;
      next();
    } catch {
      next(new Error("JWT_INVALID"));
    }
  });

  /* ================= CONNECTION ================= */

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;

    socket.join(`${role}_${userId}`);
    socket.join(`threads_${role}_${userId}`);

    /* =====================================================
       JOIN CHAT
    ===================================================== */

    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      if (!corsa_id || !cliente_id) return;

      const room = `chat_${corsa_id}_${cliente_id}`;
      socket.join(room);

      try {
        const { rows } = await pool.query(
          `
          SELECT id, corsa_id, cliente_id, sender_id,
                 testo AS text,
                 created_at
          FROM messaggi
          WHERE corsa_id=$1 AND cliente_id=$2
          ORDER BY created_at ASC
          `,
          [corsa_id, cliente_id]
        );

        socket.emit("init_chat", {
          corsa_id,
          cliente_id,
          messages: rows,
        });
      } catch (err) {
        log("ERROR", "INIT_CHAT_FAILED", { message: err.message });
      }
    });

    /* =====================================================
       SEND MESSAGE
    ===================================================== */

    socket.on("send_message", async (payload) => {
      try {
        const { corsa_id, cliente_id, text, client_msg_id } = payload || {};

        if (!corsa_id || !cliente_id) return;

        const trimmed = text?.trim();
        if (!trimmed) return;

        const threadRes = await pool.query(
          `
          SELECT driver_id
          FROM chat_threads
          WHERE corsa_id=$1 AND cliente_id=$2
          `,
          [corsa_id, cliente_id]
        );

        const thread = threadRes.rows[0];
        if (!thread) return;

        const msgKey = client_msg_id || crypto.randomUUID();

        const msgRes = await pool.query(
          `
          INSERT INTO messaggi (
            corsa_id,
            cliente_id,
            sender_id,
            testo,
            client_msg_id,
            created_at
          )
          VALUES ($1,$2,$3,$4,$5,NOW())
          RETURNING *
          `,
          [corsa_id, cliente_id, userId, trimmed, msgKey]
        );

        const msg = msgRes.rows[0];

        const recipientId =
          role === "cliente" ? thread.driver_id : cliente_id;

        if (!msg?.id || !recipientId) return;

        /* ================= RECEIPT (SAFE UPSERT) ================= */

        await pool.query(
          `
          INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at)
          VALUES ($1,$2,NULL,NULL)
          ON CONFLICT (message_id, user_id)
          DO NOTHING
          `,
          [msg.id, recipientId]
        );

        /* ================= THREAD UPDATE ================= */

        await pool.query(
          `
          UPDATE chat_threads
          SET last_message=$3::jsonb,
              updated_at=NOW()
          WHERE corsa_id=$1 AND cliente_id=$2
          `,
          [
            corsa_id,
            cliente_id,
            JSON.stringify({
              text: trimmed,
              created_at: msg.created_at,
            }),
          ]
        );

        /* ================= EMIT ================= */

        io.to(`chat_${corsa_id}_${cliente_id}`).emit("new_message", msg);

        /* ================= DELIVERY ================= */

        const recipientRoom = `${role === "cliente" ? "autista" : "cliente"}_${recipientId}`;
        const clients = io.sockets.adapter.rooms.get(recipientRoom);

        if (clients?.size > 0) {
          await pool.query(
            `
            UPDATE message_receipts
            SET delivered_at = NOW()
            WHERE message_id=$1 AND user_id=$2
            `,
            [msg.id, recipientId]
          );

          io.to(recipientRoom).emit("message_delivered", {
            message_id: msg.id,
            corsa_id,
            cliente_id,
            delivered_at: Date.now(),
          });
        }
      } catch (err) {
        log("ERROR", "SEND_FAILED", { message: err.message });
      }
    });

    /* =====================================================
       MARK AS READ (ROBUST VERSION)
    ===================================================== */

    socket.on("mark_as_read", async ({ corsa_id, cliente_id }) => {
      try {
        if (!corsa_id || !cliente_id) return;

        log("READ_EVENT", "INCOMING", {
          corsa_id,
          cliente_id,
          userId,
        });

        // 🔥 BASE: NON dipende da receipts
        const { rows } = await pool.query(
          `
          SELECT id
          FROM messaggi
          WHERE corsa_id=$1 AND cliente_id=$2
          `,
          [corsa_id, cliente_id]
        );

        const messageIds = rows.map(r => r.id);

        if (messageIds.length > 0) {
          await pool.query(
            `
            UPDATE message_receipts
            SET read_at = NOW()
            WHERE message_id = ANY($1)
              AND user_id = $2
            `,
            [messageIds, userId]
          );
        }

        log("READ_EVENT", "CONFIRMED", {
          count: messageIds.length,
        });

        io.to(`chat_${corsa_id}_${cliente_id}`).emit("message_read", {
          message_ids: messageIds,
          corsa_id,
          cliente_id,
          reader_id: userId,
          read_at: Date.now(),
        });
      } catch (err) {
        log("ERROR", "READ_FAILED", { message: err.message });
      }
    });

    socket.on("disconnect", () => {});
  });
};