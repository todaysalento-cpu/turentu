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
  console.log("🔔 NOTIFICATION ->", { userId, role, type: notification?.type });

  io.to(`${role}_${userId}`).emit("new_notification", notification);
};

/* ===================== THREAD PUSH ===================== */
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

    console.log("🧵 THREAD UPDATE", {
      corsaId,
      clienteId,
      driverId: thread.driver_id,
    });

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

      console.log("🔐 AUTH OK", {
        userId: decoded.id,
        role: decoded.role,
      });

      next();
    } catch {
      console.log("❌ AUTH FAILED");
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
    socket.on("join_chat", ({ corsa_id, cliente_id }) => {
      const corsaId = Number(corsa_id);
      const clienteId = Number(cliente_id);

      if (!corsaId || !clienteId) return;

      console.log("📥 JOIN CHAT", { userId, corsaId, clienteId });

      socket.join(`chat_${corsaId}_${clienteId}`);
    });

    /* ================= SEND MESSAGE ================= */
    socket.on("send_message", async (payload) => {
      console.log("📤 SEND_MESSAGE EVENT", payload);

      if (!payload) return;

      const { corsa_id, cliente_id, text, client_msg_id } = payload;

      const corsaId = Number(corsa_id);
      const clienteId = Number(cliente_id);
      const trimmed = text?.trim();

      if (!corsaId || !clienteId || !trimmed) {
        console.log("⚠️ INVALID MESSAGE PAYLOAD");
        return;
      }

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
        if (!thread) {
          console.log("❌ THREAD NOT FOUND");
          return;
        }

        const driverId = thread.driver_id;
        const msgKey = client_msg_id || crypto.randomUUID();

        console.log("💾 INSERT MESSAGE", {
          corsaId,
          clienteId,
          sender: userId,
          msgKey,
        });

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

        console.log("📡 EMIT NEW MESSAGE", {
          room,
          msgId: msg.id,
        });

        io.to(room).emit("new_message", msg);

        /* ================= DELIVERY ================= */
        const recipientId = role === "cliente" ? driverId : clienteId;

        console.log("📦 DELIVERY SET", {
          messageId: msg.id,
          recipientId,
        });

        await pool.query(
          `
          INSERT INTO message_receipts (message_id, user_id, delivered_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (message_id, user_id)
          DO UPDATE SET delivered_at = COALESCE(message_receipts.delivered_at, NOW())
          `,
          [msg.id, recipientId]
        );

        io.to(
          `${role === "cliente" ? "autista" : "cliente"}_${recipientId}`
        ).emit("message_delivered", {
          message_id: msg.id,
          corsa_id: corsaId,
          cliente_id: clienteId,
          delivered_at: Date.now(),
        });

        console.log("🧵 THREAD PUSH AFTER SEND");
        await pushThreadUpdate(corsaId, clienteId);

        console.log("🔔 SENDING NOTIFICATION");
        sendNotification({
          userId: recipientId,
          role: role === "cliente" ? "autista" : "cliente",
          notification: {
            type: "new_message",
            corsa_id: corsaId,
            cliente_id: clienteId,
            text: trimmed,
          },
        });

      } catch (err) {
        console.error("❌ SEND_MESSAGE ERROR:", err);
      }
    });

    /* ================= MARK AS READ ================= */
    socket.on("mark_as_read", async ({ corsa_id, cliente_id }) => {
      const corsaId = Number(corsa_id);
      const clienteId = Number(cliente_id);

      console.log("👁 MARK_AS_READ", {
        userId,
        corsaId,
        clienteId,
      });

      try {
        const result = await pool.query(
          `
          UPDATE message_receipts mr
          SET read_at = NOW()
          FROM messaggi m
          WHERE m.id = mr.message_id
            AND m.corsa_id = $1
            AND m.cliente_id = $2
            AND mr.user_id = $3
            AND mr.read_at IS NULL
          `,
          [corsaId, clienteId, userId]
        );

        console.log("✅ READ UPDATED ROWS:", result.rowCount);

        io.to(`chat_${corsaId}_${clienteId}`).emit("message_read", {
          corsa_id: corsaId,
          cliente_id: clienteId,
          reader_id: userId,
          read_at: Date.now(),
        });

      } catch (err) {
        console.error("❌ MARK_AS_READ ERROR:", err);
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