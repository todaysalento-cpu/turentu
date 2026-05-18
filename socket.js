import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import crypto from "crypto";

let io;

/* ================= IO ================= */

export const getIO = () => {
  if (!io) throw new Error("Socket.io non inizializzato!");
  return io;
};

/* ================= NOTIFICATION ================= */

export const sendNotification = ({ userId, role, notification }) => {
  if (!io) return;
  if (!userId || !role || !notification) return;

  const room = `${role}_${userId}`;

  console.log("🔔 [NOTIF] SEND →", room, notification);

  io.to(room).emit("new_notification", {
    ...notification,
    sentAt: Date.now(),
  });
};

/* ================= SOCKET SETUP ================= */

export const setupSocket = (ioServer) => {
  io = ioServer;

  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  /* ================= AUTH ================= */

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    console.log("🔐 AUTH TOKEN RECEIVED:", !!token);

    if (!token) return next(new Error("NO_TOKEN"));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      decoded.role = decoded.role?.toLowerCase() || "cliente";

      socket.user = decoded;

      console.log("🟢 AUTH OK:", {
        id: decoded.id,
        role: decoded.role,
      });

      next();
    } catch (err) {
      console.log("❌ JWT ERROR:", err.message);
      return next(new Error("JWT_INVALID"));
    }
  });

  /* ================= CONNECTION ================= */

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;

    console.log("🟢 SOCKET CONNECTED:", socket.id, {
      userId,
      role,
    });

    socket.join(`${role}_${userId}`);

    /* ================= JOIN CHAT ================= */

    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      console.log("🟦 JOIN_CHAT EVENT:", { corsa_id, cliente_id, userId });

      if (!corsa_id || !cliente_id) {
        console.log("⚠️ JOIN_CHAT INVALID PARAMS");
        return;
      }

      const room = `chat_${corsa_id}_${cliente_id}`;
      socket.join(room);

      console.log("📥 JOIN ROOM:", room);

      try {
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
           AND mr.user_id = $3
          WHERE m.corsa_id = $1
            AND m.cliente_id = $2
          ORDER BY m.created_at ASC
          `,
          [corsa_id, cliente_id, userId]
        );

        console.log("📦 INIT_CHAT ROWS:", {
          count: rows.length,
        });

        const messages = rows.map((m) => ({
          id: String(m.id),
          corsa_id: Number(m.corsa_id),
          cliente_id: Number(m.cliente_id),
          sender_id: Number(m.sender_id),
          text: m.text ?? "",
          client_msg_id: m.client_msg_id ?? null,
          created_at: Number(new Date(m.created_at)),

          status: {
            sent: true,
            delivered: Boolean(m.delivered_at),
            read: Boolean(m.read_at),
          },
        }));

        socket.emit("init_chat", {
          corsa_id,
          cliente_id,
          messages,
        });

        console.log("📤 INIT_CHAT SENT →", room);
      } catch (err) {
        console.log("❌ INIT_CHAT_FAILED:", err.message);
      }
    });

    /* ================= SEND MESSAGE ================= */

    socket.on("send_message", async (payload) => {
      console.log("📨 SEND_MESSAGE:", payload);

      try {
        const { corsa_id, cliente_id, text, client_msg_id } = payload;

        const trimmed = text?.trim();
        if (!trimmed) {
          console.log("⚠️ EMPTY MESSAGE");
          return;
        }

        const threadRes = await pool.query(
          `
          SELECT driver_id
          FROM chat_threads
          WHERE corsa_id=$1 AND cliente_id=$2
          `,
          [corsa_id, cliente_id]
        );

        console.log("🧵 THREAD FOUND:", threadRes.rows[0]);

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

        console.log("💾 MESSAGE INSERTED:", msg.id);

        const recipientId =
          role === "cliente" ? thread.driver_id : cliente_id;

        console.log("👤 RECIPIENT:", recipientId);

        await pool.query(
          `
          INSERT INTO message_receipts (
            message_id,
            user_id,
            delivered_at,
            read_at
          )
          VALUES ($1,$2,NULL,NULL)
          ON CONFLICT DO NOTHING
          `,
          [msg.id, recipientId]
        );

        io.to(`chat_${corsa_id}_${cliente_id}`).emit("new_message", {
          id: String(msg.id),
          corsa_id,
          cliente_id,
          sender_id: userId,
          text: trimmed,
          client_msg_id: msgKey,
          created_at: Number(new Date(msg.created_at)),
          status: { sent: true, delivered: false, read: false },
        });

        console.log("📤 NEW_MESSAGE EMITTED");

      } catch (err) {
        console.log("❌ SEND_FAILED:", err.message);
      }
    });

    /* ================= MARK AS READ ================= */

    socket.on("mark_as_read", async ({ corsa_id, cliente_id }) => {
      console.log("📖 MARK_AS_READ:", { corsa_id, cliente_id, userId });

      try {
        if (!corsa_id || !cliente_id) {
          console.log("⚠️ INVALID READ PARAMS");
          return;
        }

        const room = `chat_${corsa_id}_${cliente_id}`;

        await pool.query(
          `
          UPDATE message_receipts mr
          SET read_at = NOW()
          FROM messaggi m
          WHERE m.id = mr.message_id
            AND m.corsa_id=$1
            AND m.cliente_id=$2
            AND mr.user_id=$3
            AND mr.read_at IS NULL
          `,
          [corsa_id, cliente_id, userId]
        );

        const { rows } = await pool.query(
          `
          SELECT mr.message_id
          FROM message_receipts mr
          JOIN messaggi m ON m.id = mr.message_id
          WHERE m.corsa_id=$1
            AND m.cliente_id=$2
            AND mr.user_id=$3
            AND mr.read_at IS NOT NULL
          `,
          [corsa_id, cliente_id, userId]
        );

        const messageIds = rows.map(r => String(r.message_id));

        console.log("📦 READ UPDATED:", messageIds.length);

        io.to(room).emit("message_read", {
          message_ids: messageIds,
          corsa_id,
          cliente_id,
          reader_id: userId,
          read_at: Date.now(),
        });

        console.log("📤 MESSAGE_READ EMITTED →", room);

      } catch (err) {
        console.log("❌ READ_FAILED:", err.message);
      }
    });

    socket.on("disconnect", () => {
      console.log("❌ DISCONNECT:", socket.id);
    });
  });
};