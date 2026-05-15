import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import crypto from "crypto";

let io;

/* ================= IO ACCESS ================= */
export const getIO = () => {
  if (!io) throw new Error("Socket.io non inizializzato!");
  return io;
};

/* ================= NOTIFICATIONS ================= */
export const sendNotification = ({ userId, role, notification }) => {
  if (!io) return;

  io.to(`${role}_${userId}`).emit("new_notification", notification);
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

    /* ================= JOIN CHAT ================= */
    socket.on("join_chat", ({ corsa_id, cliente_id }) => {
      if (!corsa_id || !cliente_id) return;
      socket.join(`chat_${corsa_id}_${cliente_id}`);
    });

    /* ================= SEND MESSAGE ================= */
    socket.on("send_message", async (payload) => {
      const { corsa_id, cliente_id, text, client_msg_id } = payload;

      const trimmed = text?.trim();
      if (!trimmed) return;

      try {
        /* ================= THREAD CHECK ================= */
        const { rows: threadRows } = await pool.query(
          `SELECT driver_id, cliente_id
           FROM chat_threads
           WHERE corsa_id=$1 AND cliente_id=$2`,
          [corsa_id, cliente_id]
        );

        const thread = threadRows[0];
        if (!thread) return;

        const msgKey = client_msg_id || crypto.randomUUID();

        /* ================= INSERT MESSAGE ================= */
        const { rows } = await pool.query(
          `
          INSERT INTO messaggi (
            corsa_id,
            cliente_id,
            sender_id,
            testo,
            client_msg_id
          )
          VALUES ($1,$2,$3,$4,$5)
          RETURNING *
          `,
          [corsa_id, cliente_id, userId, trimmed, msgKey]
        );

        const msg = rows[0];

        const normalizedMsg = {
          ...msg,
          created_at: Number(msg.created_at),
        };

        /* ================= UPDATE THREAD ================= */
        await pool.query(
          `
          UPDATE chat_threads
          SET last_message = $3::jsonb,
              updated_at = NOW()
          WHERE corsa_id=$1 AND cliente_id=$2
          `,
          [
            corsa_id,
            cliente_id,
            JSON.stringify({
              text: trimmed,
              created_at: normalizedMsg.created_at,
            }),
          ]
        );

        /* ================= EMIT MESSAGE ================= */
        io.to(`chat_${corsa_id}_${cliente_id}`).emit(
          "new_message",
          normalizedMsg
        );

        /* ================= DELIVERY LOGIC SAFE ================= */
        const recipientId =
          role === "cliente" ? thread.driver_id : cliente_id;

        const recipientRole =
          role === "cliente" ? "autista" : "cliente";

        const recipientRoom = `${recipientRole}_${recipientId}`;

        const clients =
          io.sockets.adapter.rooms.get(recipientRoom);

        const deliveredAt = Date.now();

        if (clients && clients.size > 0) {
          await pool.query(
            `
            INSERT INTO message_receipts (message_id, user_id, delivered_at)
            VALUES ($1,$2,NOW())
            ON CONFLICT (message_id, user_id)
            DO UPDATE SET delivered_at = COALESCE(message_receipts.delivered_at, NOW())
            `,
            [msg.id, recipientId]
          );

          io.to(recipientRoom).emit("message_delivered", {
            message_id: msg.id,
            corsa_id,
            cliente_id,
            delivered_at: deliveredAt,
          });
        }
      } catch (err) {
        console.error("SEND_MESSAGE ERROR:", err);
      }
    });

    /* ================= READ ================= */
    socket.on("mark_as_read", async ({ corsa_id, cliente_id }) => {
      try {
        if (!corsa_id || !cliente_id) return;

        const { rows } = await pool.query(
          `
          UPDATE message_receipts mr
          SET read_at = NOW()
          FROM messaggi m
          WHERE m.id = mr.message_id
            AND m.corsa_id = $1
            AND m.cliente_id = $2
            AND mr.user_id = $3
            AND mr.read_at IS NULL
          RETURNING m.id
          `,
          [corsa_id, cliente_id, userId]
        );

        const messageIds = rows.map((r) => r.id);

        /* ================= RESET UNREAD ================= */
        await pool.query(
          `
          UPDATE chat_threads
          SET unreadcount = 0
          WHERE corsa_id=$1 AND cliente_id=$2
          `,
          [corsa_id, cliente_id]
        );

        io.to(`chat_${corsa_id}_${cliente_id}`).emit("message_read", {
          message_ids: messageIds,
          corsa_id,
          cliente_id,
          reader_id: userId,
          read_at: Date.now(),
        });
      } catch (err) {
        console.error("MARK_AS_READ ERROR:", err);
      }
    });

    /* ================= DISCONNECT ================= */
    socket.on("disconnect", () => {});
  });
};