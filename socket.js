import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import { getCorseCache } from "./services/search/search.cache.js";

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

/* ===================== THREAD PUSH (NEW) ===================== */
const pushThreadUpdate = async (corsaId, clienteId) => {
  if (!io) return;

  try {
    const { rows } = await pool.query(
      `
      SELECT *
      FROM chat_threads
      WHERE corsa_id = $1 AND cliente_id = $2
      `,
      [corsaId, clienteId]
    );

    const thread = rows[0];
    if (!thread) return;

    io.to(`chat_threads_${thread.driver_id}`).emit("thread_update", thread);
    io.to(`chat_threads_${thread.cliente_id}`).emit("thread_update", thread);

  } catch (err) {
    console.error("pushThreadUpdate error:", err);
  }
};

/* ===================== SOCKET SETUP ===================== */
const setupSocket = (ioServer) => {
  io = ioServer;

  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("NO_TOKEN"));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);

      decoded.role = ["autista", "cliente"].includes(decoded.role?.toLowerCase())
        ? decoded.role.toLowerCase()
        : "cliente";

      socket.user = decoded;
      next();
    } catch {
      return next(new Error("JWT_INVALID"));
    }
  });

  io.on("connection", async (socket) => {
    const { id: userId, role } = socket.user;

    console.log("🟢 SOCKET CONNECTED", { socketId: socket.id, userId, role });

    const sentMessages = new Set();

    /* ===================== PERSONAL ROOM ===================== */
    socket.join(`${role}_${userId}`);

    /* ===================== HOME CHAT ROOM (NEW) ===================== */
    socket.join(`chat_threads_${userId}`);

    /* ===================== AUTISTA ROOMS ===================== */
    if (role === "autista") {
      try {
        const corseCache = await getCorseCache();

        for (const c of corseCache) {
          if (Number(c.driver_id) !== Number(userId)) continue;
          socket.join(`corsa_${c.id}`);
        }
      } catch (err) {
        console.error("❌ errore corse:", err);
      }
    }

    /* ===================== JOIN CHAT ===================== */
    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      const corsaId = Number(corsa_id);
      const clienteId = Number(cliente_id);

      if (!corsaId || !clienteId) return;

      const room = `chat_${corsaId}_${clienteId}`;
      socket.join(room);
    });

    /* ===================== TYPING ===================== */
    socket.on("typing", ({ corsa_id, cliente_id }) => {
      io.to(`chat_${corsa_id}_${cliente_id}`).emit("typing", {
        userId,
        corsa_id,
        cliente_id,
      });
    });

    socket.on("stop_typing", ({ corsa_id, cliente_id }) => {
      io.to(`chat_${corsa_id}_${cliente_id}`).emit("stop_typing", {
        userId,
        corsa_id,
        cliente_id,
      });
    });

    /* ===================== MARK AS READ ===================== */
    socket.on("mark_as_read", async ({ corsa_id, cliente_id }) => {
      const corsaId = Number(corsa_id);
      const clienteId = Number(cliente_id);

      try {
        await pool.query(
          `
          UPDATE chat_threads
          SET unread_count = 0,
              updated_at = NOW()
          WHERE corsa_id = $1
            AND cliente_id = $2
          `,
          [corsaId, clienteId]
        );

        await pushThreadUpdate(corsaId, clienteId);

        io.to(`chat_${corsaId}_${clienteId}`).emit("messages_read", {
          corsa_id: corsaId,
          cliente_id: clienteId,
          reader_id: userId,
        });

      } catch (err) {
        console.error("mark_as_read error:", err);
      }
    });

    /* ===================== SEND MESSAGE ===================== */
    socket.on("send_message", async (payload) => {
      if (!payload) return;

      const { corsa_id, cliente_id, text, client_msg_id } = payload;
      if (!text?.trim()) return;

      const corsaId = Number(corsa_id);
      const clienteId = Number(cliente_id);

      const room = `chat_${corsaId}_${clienteId}`;

      const msgKey =
        client_msg_id || `${userId}_${Date.now()}_${Math.random()}`;

      if (sentMessages.has(msgKey)) return;
      sentMessages.add(msgKey);

      try {
        /* ================= INSERT MESSAGE ================= */
        const { rows } = await pool.query(
          `
          INSERT INTO messaggi (
            corsa_id,
            cliente_id,
            sender_id,
            testo,
            client_msg_id,
            read_status
          )
          VALUES ($1,$2,$3,$4,$5,jsonb_build_object('autista',false,'cliente',false))
          ON CONFLICT (client_msg_id) DO NOTHING
          RETURNING
            id,
            corsa_id,
            cliente_id,
            sender_id,
            testo AS text,
            created_at
          `,
          [corsaId, clienteId, userId, text.trim(), msgKey]
        );

        if (!rows.length) return;

        const msg = rows[0];

        /* ================= REALTIME MESSAGE ================= */
        io.to(room).emit("new_message", msg);

        /* ================= THREAD UPDATE (🔥 KEY PART) ================= */
        await pushThreadUpdate(corsaId, clienteId);

        /* ================= NOTIFICATION ================= */
        sendNotification({
          userId: clienteId,
          role: "cliente",
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

    /* ================= DISCONNECT ================= */
    socket.on("disconnect", (reason) => {
      console.log("❌ DISCONNECT", { socketId: socket.id, userId, reason });
    });
  });
};

export {
  setupSocket,
  getIO,
  sendNotification,
};