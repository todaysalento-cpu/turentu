import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import crypto from "crypto";

let io;

/* ===================== IO ===================== */
const getIO = () => {
  if (!io) throw new Error("Socket.io non inizializzato!");
  return io;
};

/* ===================== NOTIFICATION ===================== */
const sendNotification = ({ userId, role, notification }) => {
  if (!io) return;
  io.to(`${role}_${userId}`).emit("new_notification", notification);
};

/* ===================== THREAD PUSH ===================== */
const pushThreadUpdate = async (corsaId, clienteId) => {
  if (!io) return;

  try {
    const { rows } = await pool.query(
      `
      SELECT corsa_id, cliente_id, driver_id, last_message, unread_count, updated_at
      FROM chat_threads
      WHERE corsa_id = $1 AND cliente_id = $2
      `,
      [corsaId, clienteId]
    );

    const thread = rows[0];
    if (!thread) return;

    io.to(`chat_threads_${clienteId}`).emit("thread_update", thread);
    io.to(`chat_threads_driver_${thread.driver_id}`).emit("thread_update", thread);
  } catch (err) {
    console.error("❌ pushThreadUpdate:", err);
  }
};

/* ===================== SOCKET ===================== */
const setupSocket = (ioServer) => {
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
      return next(new Error("JWT_INVALID"));
    }
  });

  /* ================= CONNECTION ================= */
  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;

    console.log("🟢 CONNECTED", { userId, role });

    socket.join(`${role}_${userId}`);

    socket.join(
      role === "cliente"
        ? `chat_threads_${userId}`
        : `chat_threads_driver_${userId}`
    );

    /* ================= JOIN CHAT ================= */
    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      const corsaId = Number(corsa_id);
      const clienteId = Number(cliente_id);

      if (!corsaId || !clienteId) return;

      socket.join(`chat_${corsaId}_${clienteId}`);
    });

    /* ================= SEND MESSAGE ================= */
    socket.on("send_message", async (payload) => {
      if (!payload) return;

      const { corsa_id, cliente_id, text, client_msg_id } = payload;

      const corsaId = Number(corsa_id);
      const clienteId = Number(cliente_id);
      const trimmed = text?.trim();

      if (!corsaId || !clienteId || !trimmed) return;

      const room = `chat_${corsaId}_${clienteId}`;

      try {
        const { rows: threadRows } = await pool.query(
          `
          SELECT driver_id FROM chat_threads
          WHERE corsa_id=$1 AND cliente_id=$2
          `,
          [corsaId, clienteId]
        );

        const thread = threadRows[0];
        if (!thread) return;

        const driverId = thread.driver_id;
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
          [corsaId, clienteId, userId, trimmed, msgKey]
        );

        const msg = {
          ...rows[0],
          created_at: new Date(rows[0].created_at).getTime(),
        };

        /* ================= THREAD UPDATE ================= */
        await pool.query(
          `
          UPDATE chat_threads
          SET last_message=$3,
              unread_count=unread_count+1,
              updated_at=NOW()
          WHERE corsa_id=$1 AND cliente_id=$2
          `,
          [
            corsaId,
            clienteId,
            JSON.stringify({
              text: trimmed,
              created_at: msg.created_at,
            }),
          ]
        );

        /* ================= MESSAGE EVENT ================= */
        io.to(room).emit("new_message", msg);

        /* ================= DELIVERY (REAL WHATSAPP STYLE) ================= */
        const recipientId = role === "cliente" ? driverId : clienteId;

        await pool.query(
          `
          INSERT INTO message_receipts (message_id, user_id, delivered_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (message_id, user_id, device_id)
          DO UPDATE SET delivered_at = COALESCE(message_receipts.delivered_at, NOW())
          `,
          [msg.id, recipientId]
        );

        io.to(`${role === "cliente" ? "autista" : "cliente"}_${recipientId}`).emit(
          "message_delivered",
          {
            message_id: msg.id,
            corsa_id: corsaId,
            cliente_id: clienteId,
            delivered_at: Date.now(),
          }
        );

        /* ================= THREAD UPDATE ================= */
        await pushThreadUpdate(corsaId, clienteId);

        /* ================= NOTIFICATION ================= */
        sendNotification({
          userId: recipientId,
          role: role === "cliente" ? "autista" : "cliente",
          notification: {
            type: "new_message",
            corsa_id: corsaId,
            cliente_id: clienteId,
            text: msg.text,
          },
        });

      } catch (err) {
        console.error("❌ send_message:", err);
      }
    });

    /* ================= MARK AS READ (REAL WHATSAPP STYLE) ================= */
    socket.on("mark_as_read", async ({ corsa_id, cliente_id }) => {
      const corsaId = Number(corsa_id);
      const clienteId = Number(cliente_id);

      try {
        /* mark read per-device/user */
        await pool.query(
          `
          UPDATE message_receipts mr
          SET read_at = NOW()
          FROM messaggi m
          WHERE m.id = mr.message_id
            AND m.corsa_id = $1
            AND m.cliente_id = $2
            AND mr.user_id = $3
          `,
          [corsaId, clienteId, userId]
        );

        await pool.query(
          `
          UPDATE chat_threads
          SET unread_count = 0
          WHERE corsa_id=$1 AND cliente_id=$2
          `,
          [corsaId, clienteId]
        );

        io.to(`chat_${corsaId}_${clienteId}`).emit("message_read", {
          corsa_id: corsaId,
          cliente_id: clienteId,
          reader_id: userId,
          read_at: Date.now(),
        });

      } catch (err) {
        console.error("❌ mark_as_read:", err);
      }
    });

    socket.on("disconnect", () => {
      console.log("❌ DISCONNECTED", { userId });
    });
  });
};

export {
  setupSocket,
  getIO,
  sendNotification,
};