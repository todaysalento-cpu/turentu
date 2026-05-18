// ======================= socket.js =======================
import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import { getCorseCache } from "./services/search/search.cache.js";

let io;

// =======================
const getIO = () => {
  if (!io) throw new Error("Socket.io non inizializzato!");
  return io;
};

// =======================
// NOTIFICATION
// =======================
const sendNotification = ({ userId, role, notification }) => {
  if (!io || !userId || !role) return;

  io.to(`${role}_${userId}`).emit("new_notification", notification);
};

// =======================
// SOCKET SETUP
// =======================
const setupSocket = (ioServer) => {
  io = ioServer;

  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  // =======================
  // AUTH
  // =======================
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("NO_TOKEN"));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);

      decoded.role = decoded.role?.toLowerCase() || "cliente";
      socket.user = decoded;

      next();
    } catch (err) {
      return next(new Error("JWT_INVALID"));
    }
  });

  // =======================
  // CONNECTION
  // =======================
  io.on("connection", async (socket) => {
    const { id: userId, role } = socket.user;

    socket.join(`${role}_${userId}`);

    // =======================
    // CHAT JOIN
    // =======================
    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      if (!corsa_id || !cliente_id) return;

      const room = `chat_${corsa_id}_${cliente_id}`;
      socket.join(room);

      console.log("🟦 JOIN_CHAT", { userId, corsa_id, cliente_id });

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

          WHERE m.corsa_id=$1 AND m.cliente_id=$2
          ORDER BY m.created_at ASC
          `,
          [corsa_id, cliente_id, userId]
        );

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
            delivered: !!m.delivered_at,
            read: !!m.read_at,
          },
        }));

        socket.emit("init_chat", {
          corsa_id,
          cliente_id,
          messages,
        });
      } catch (err) {
        console.error("❌ INIT_CHAT_FAILED", err);
      }
    });

    // =======================
    // SEND MESSAGE
    // =======================
    socket.on("send_message", async (payload) => {
      const { corsa_id, cliente_id, text, client_msg_id } = payload;
      if (!text?.trim()) return;

      const room = `chat_${corsa_id}_${cliente_id}`;

      try {
        const { rows } = await pool.query(
          `
          INSERT INTO messaggi
            (corsa_id, cliente_id, sender_id, testo, client_msg_id, created_at)
          VALUES ($1,$2,$3,$4,$5,NOW())
          RETURNING *
          `,
          [corsa_id, cliente_id, userId, text.trim(), client_msg_id || null]
        );

        const msg = rows[0];

        // 🔥 crea receipt per destinatario
        const recipientId =
          role === "cliente" ? null : cliente_id;

        if (recipientId) {
          await pool.query(
            `
            INSERT INTO message_receipts (message_id, user_id)
            VALUES ($1,$2)
            ON CONFLICT DO NOTHING
            `,
            [msg.id, recipientId]
          );
        }

        io.to(room).emit("new_message", {
          id: msg.id,
          corsa_id,
          cliente_id,
          sender_id: userId,
          text: msg.testo,
          client_msg_id,
          created_at: msg.created_at,
        });

      } catch (err) {
        console.error("❌ SEND_MESSAGE_FAILED", err);
      }
    });

    // =======================
    // MARK AS READ (🔥 MANCAVA)
    // =======================
    socket.on("mark_as_read", async ({ corsa_id, cliente_id }) => {
      try {
        const room = `chat_${corsa_id}_${cliente_id}`;

        await pool.query(
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
          [corsa_id, cliente_id, userId]
        );

        const { rows } = await pool.query(
          `
          SELECT m.id
          FROM messaggi m
          JOIN message_receipts mr ON mr.message_id = m.id
          WHERE m.corsa_id=$1
            AND m.cliente_id=$2
            AND mr.user_id=$3
            AND mr.read_at IS NOT NULL
          `,
          [corsa_id, cliente_id, userId]
        );

        io.to(room).emit("message_read", {
          corsa_id,
          cliente_id,
          message_ids: rows.map(r => String(r.id)),
          reader_id: userId,
          read_at: Date.now(),
        });

      } catch (err) {
        console.error("❌ MARK_AS_READ_FAILED", err);
      }
    });

    // =======================
    // DISCONNECT
    // =======================
    socket.on("disconnect", () => {});
  });
};

export {
  setupSocket,
  getIO,
  sendNotification,
  emitNuovaCorsa,
  emitCorsaUpdate,
  emitPendingUpdate,
  emitNewPending,
};