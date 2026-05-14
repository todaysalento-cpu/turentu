import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";

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
    } catch (err) {
      return next(new Error("JWT_INVALID"));
    }
  });

  /* ================= CONNECTION ================= */
  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;

    console.log("🟢 SOCKET CONNECTED", { socketId: socket.id, userId, role });

    socket.join(`${role}_${userId}`);

    if (role === "cliente") {
      socket.join(`chat_threads_${userId}`);
    } else {
      socket.join(`chat_threads_driver_${userId}`);
    }

    /* ================= JOIN CHAT ================= */
    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      const corsaId = Number(corsa_id);
      const clienteId = Number(cliente_id);

      if (!corsaId || !clienteId) return;

      const { rows } = await pool.query(
        `
        SELECT driver_id
        FROM chat_threads
        WHERE corsa_id = $1 AND cliente_id = $2
        `,
        [corsaId, clienteId]
      );

      const thread = rows[0];
      if (!thread) return;

      const isCliente = role === "cliente" && Number(clienteId) === userId;
      const isDriver = role === "autista" && Number(thread.driver_id) === userId;

      if (!isCliente && !isDriver) return;

      socket.join(`chat_${corsaId}_${clienteId}`);

      console.log("💬 JOIN CHAT", {
        room: `chat_${corsaId}_${clienteId}`,
        userId,
        role,
      });
    });

    /* ================= TYPING ================= */
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

    /* ================= MARK AS READ ================= */
    socket.on("mark_as_read", async ({ corsa_id, cliente_id }) => {
      const corsaId = Number(corsa_id);
      const clienteId = Number(cliente_id);

      await pool.query(
        `
        UPDATE chat_threads
        SET unread_count = 0
        WHERE corsa_id = $1 AND cliente_id = $2
        `,
        [corsaId, clienteId]
      );

      await pushThreadUpdate(corsaId, clienteId);

      io.to(`chat_${corsaId}_${clienteId}`).emit("messages_read", {
        corsa_id: corsaId,
        cliente_id: clienteId,
        reader_id: userId,
      });
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
        /* ================= THREAD ================= */
        const { rows: threadRows } = await pool.query(
          `
          SELECT driver_id
          FROM chat_threads
          WHERE corsa_id = $1 AND cliente_id = $2
          `,
          [corsaId, clienteId]
        );

        const thread = threadRows[0];
        if (!thread) return;

        const driverId = thread.driver_id;

        /* ================= AUTH CHECK (CRITICO) ================= */
        const isCliente = role === "cliente" && Number(clienteId) === userId;
        const isDriver = role === "autista" && Number(thread.driver_id) === userId;

        if (!isCliente && !isDriver) return;

        const msgKey = client_msg_id || crypto.randomUUID();

        /* ================= INSERT MESSAGE ================= */
        const { rows } = await pool.query(
          `
          INSERT INTO messaggi (
            corsa_id,
            cliente_id,
            sender_id,
            testo,
            client_msg_id,
            read_status,
            status
          )
          VALUES (
            $1,$2,$3,$4,$5,
            jsonb_build_object('autista',false,'cliente',false),
            jsonb_build_object('sent',true,'delivered',false,'read',false)
          )
          ON CONFLICT (client_msg_id) DO NOTHING
          RETURNING *
          `,
          [corsaId, clienteId, userId, trimmed, msgKey]
        );

        if (!rows.length) return;

        const msg = {
          ...rows[0],
          created_at: new Date(rows[0].created_at).getTime(),
        };

        /* ================= THREAD UPDATE ================= */
        await pool.query(
          `
          UPDATE chat_threads
          SET
            last_message = $3,
            unread_count = unread_count + 1,
            updated_at = NOW()
          WHERE corsa_id = $1 AND cliente_id = $2
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

        /* ================= EMIT ================= */
        io.to(room).emit("new_message", msg);

        await pushThreadUpdate(corsaId, clienteId);

        /* ================= NOTIFICATIONS ================= */
        if (role === "cliente") {
          sendNotification({
            userId: driverId,
            role: "autista",
            notification: {
              type: "new_message",
              corsa_id: corsaId,
              cliente_id: clienteId,
              text: msg.text,
            },
          });
        } else {
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
        }
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