import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import crypto from "crypto";

let io;

const getIO = () => {
  if (!io) throw new Error("Socket.io non inizializzato!");
  return io;
};

const sendNotification = ({ userId, role, notification }) => {
  if (!io) return;
  io.to(`${role}_${userId}`).emit("new_notification", notification);
};

const pushThreadUpdate = async (corsaId, clienteId) => {
  if (!io) return;

  try {
    const { rows } = await pool.query(
      `
      SELECT corsa_id, cliente_id, driver_id, last_message, updated_at
      FROM chat_threads
      WHERE corsa_id = $1 AND cliente_id = $2
      `,
      [corsaId, clienteId]
    );

    const thread = rows[0];
    if (!thread) return;

    io.to(`threads_cliente_${thread.cliente_id}`).emit("thread_update", thread);
    io.to(`threads_autista_${thread.driver_id}`).emit("thread_update", thread);
  } catch (err) {
    console.error("pushThreadUpdate:", err);
  }
};

const setupSocket = (ioServer) => {
  io = ioServer;

  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("NO_TOKEN"));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      decoded.role = decoded.role?.toLowerCase();
      socket.user = decoded;
      next();
    } catch {
      return next(new Error("JWT_INVALID"));
    }
  });

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;

    socket.join(`${role}_${userId}`);

    socket.join(`threads_${role}_${userId}`);

    /* JOIN CHAT */
    socket.on("join_chat", ({ corsa_id, cliente_id }) => {
      socket.join(`chat_${corsa_id}_${cliente_id}`);
    });

    /* SEND MESSAGE */
    socket.on("send_message", async (payload) => {
      const { corsa_id, cliente_id, text, client_msg_id } = payload;

      const trimmed = text?.trim();
      if (!trimmed) return;

      try {
        const { rows: threadRows } = await pool.query(
          `SELECT driver_id FROM chat_threads WHERE corsa_id=$1 AND cliente_id=$2`,
          [corsa_id, cliente_id]
        );

        const thread = threadRows[0];
        if (!thread) return;

        const driverId = thread.driver_id;
        const msgKey = client_msg_id || crypto.randomUUID();

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
              created_at: msg.created_at,
            }),
          ]
        );

        io.to(`chat_${corsa_id}_${cliente_id}`).emit("new_message", msg);

        const recipientId = role === "cliente" ? driverId : cliente_id;

        await pool.query(
          `
          INSERT INTO message_receipts (message_id, user_id, delivered_at)
          VALUES ($1,$2,NOW())
          ON CONFLICT (message_id, user_id)
          DO UPDATE SET delivered_at = COALESCE(message_receipts.delivered_at, NOW())
          `,
          [msg.id, recipientId]
        );

        io.to(`${role === "cliente" ? "autista" : "cliente"}_${recipientId}`)
          .emit("message_delivered", {
            message_id: msg.id,
            corsa_id,
            cliente_id,
            delivered_at: Date.now(),
          });

        pushThreadUpdate(corsa_id, cliente_id);

        sendNotification({
          userId: recipientId,
          role: role === "cliente" ? "autista" : "cliente",
          notification: {
            type: "new_message",
            corsa_id,
            cliente_id,
            text: trimmed,
          },
        });
      } catch (err) {
        console.error("SEND_MESSAGE ERROR:", err);
      }
    });

    /* MARK AS READ */
    socket.on("mark_as_read", async ({ corsa_id, cliente_id }) => {
      try {
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

        io.to(`chat_${corsa_id}_${cliente_id}`).emit("message_read", {
          message_ids: rows.map(r => r.id),
          corsa_id,
          cliente_id,
          reader_id: userId,
          read_at: Date.now(),
        });
      } catch (err) {
        console.error("MARK_AS_READ ERROR:", err);
      }
    });
  });
};

export { setupSocket, getIO, sendNotification };