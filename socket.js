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
  if (!io || !userId || !role || !notification) return;

  const room = `${role}_${userId}`;

  io.to(room).emit("new_notification", {
    ...notification,
    sentAt: Date.now(),
  });

  console.log("🔔 NOTIFICATION SENT ->", room);
};

/* ================= SOCKET ================= */

export const setupSocket = (ioServer) => {
  io = ioServer;

  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  /* AUTH */
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("NO_TOKEN"));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = {
        ...decoded,
        role: decoded.role?.toLowerCase() || "cliente",
      };
      next();
    } catch {
      next(new Error("JWT_INVALID"));
    }
  });

  /* CONNECTION */
  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;

    socket.join(`${role}_${userId}`);

    console.log("🟢 SOCKET CONNECTED:", { userId, role });

    /* ================= JOIN CHAT ================= */

    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      if (!corsa_id || !cliente_id) return;

      const room = `chat_${corsa_id}_${cliente_id}`;
      socket.join(room);

      console.log("🟦 JOIN_CHAT:", { room, userId });

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

        console.log("📦 INIT_CHAT ROWS:", { count: rows.length });

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
        console.error("INIT_CHAT_FAILED", err);
      }
    });

    /* ================= SEND MESSAGE ================= */

    socket.on("send_message", async (payload) => {
      try {
        const { corsa_id, cliente_id, text, client_msg_id } = payload;

        console.log("✉️ SEND_MESSAGE:", { corsa_id, cliente_id, userId });

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

        if (!thread) {
          console.log("❌ THREAD NOT FOUND");
          return;
        }

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

        /* ================= RECEIPT ================= */

        await pool.query(
          `
          INSERT INTO message_receipts (
            message_id,
            user_id,
            delivered_at,
            read_at
          )
          VALUES ($1,$2,NULL,NULL)
          ON CONFLICT (message_id, user_id, device_id) DO NOTHING
          `,
          [msg.id, recipientId]
        );

        /* ================= EMIT MESSAGE ================= */

        const normalized = {
          id: String(msg.id),
          corsa_id,
          cliente_id,
          sender_id: userId,
          text: trimmed,
          client_msg_id: msgKey,
          created_at: Number(new Date(msg.created_at)),
          status: {
            sent: true,
            delivered: false,
            read: false,
          },
        };

        io.to(`chat_${corsa_id}_${cliente_id}`).emit(
          "new_message",
          normalized
        );

        console.log("📨 MESSAGE EMITTED");

        /* ================= DELIVERY ================= */

        const recipientRole =
          role === "cliente" ? "autista" : "cliente";

        const recipientRoom = `${recipientRole}_${recipientId}`;

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
            message_id: String(msg.id),
            corsa_id,
            cliente_id,
            delivered_at: Date.now(),
          });

          console.log("📬 DELIVERED");
        }
      } catch (err) {
        console.error("SEND_FAILED:", err);
      }
    });

    /* ================= READ ================= */

    socket.on("mark_as_read", async ({ corsa_id, cliente_id }) => {
      try {
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

        io.to(room).emit("message_read", {
          message_ids: rows.map((r) => String(r.message_id)),
          corsa_id,
          cliente_id,
          reader_id: userId,
          read_at: Date.now(),
        });

        console.log("👁 READ UPDATED");
      } catch (err) {
        console.error("READ_FAILED", err);
      }
    });

    socket.on("disconnect", () => {
      console.log("🔴 DISCONNECT:", userId);
    });
  });
};