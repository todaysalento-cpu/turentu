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
  if (!io) {
    log("ERROR", "SOCKET_IO_NOT_INITIALIZED");
    throw new Error("Socket.io non inizializzato!");
  }
  return io;
};

/* ================= NOTIFICATION ================= */

export const sendNotification = ({ userId, role, notification }) => {
  if (!io) {
    log("WARN", "NOTIFICATION_SKIPPED_IO_NULL");
    return;
  }

  const room = `${role}_${userId}`;

  log("NOTIFICATION", "SEND", { room, userId, role, notification });

  io.to(room).emit("new_notification", notification);
};

/* ================= SOCKET ================= */

export const setupSocket = (ioServer) => {
  io = ioServer;

  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  log("SOCKET", "INIT");

  /* ================= AUTH ================= */

  io.use((socket, next) => {
    const requestId = crypto.randomUUID();
    socket.requestId = requestId;

    const token = socket.handshake.auth?.token;

    log("AUTH", "START", {
      requestId,
      socketId: socket.id,
      hasToken: !!token,
    });

    if (!token) {
      log("AUTH", "NO_TOKEN", { requestId });
      return next(new Error("NO_TOKEN"));
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      decoded.role = decoded.role?.toLowerCase();
      socket.user = decoded;

      log("AUTH", "OK", {
        requestId,
        userId: decoded.id,
        role: decoded.role,
      });

      next();
    } catch (err) {
      log("AUTH", "JWT_INVALID", {
        requestId,
        error: err.message,
      });
      next(new Error("JWT_INVALID"));
    }
  });

  /* ================= CONNECTION ================= */

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;
    const requestId = socket.requestId;

    log("SOCKET", "CONNECTED", { requestId, userId, role });

    const userRoom = `${role}_${userId}`;
    const threadsRoom = `threads_${role}_${userId}`;

    socket.join(userRoom);
    socket.join(threadsRoom);

    log("ROOM", "JOINED", {
      requestId,
      rooms: [userRoom, threadsRoom],
    });

    /* ================= JOIN CHAT ================= */

    socket.on("join_chat", ({ corsa_id, cliente_id }) => {
      const room = `chat_${corsa_id}_${cliente_id}`;

      log("CHAT", "JOIN_REQUEST", {
        requestId,
        room,
        corsa_id,
        cliente_id,
      });

      socket.join(room);

      log("CHAT", "JOINED_ROOM", {
        requestId,
        room,
      });
    });

    /* ================= SEND MESSAGE ================= */

    socket.on("send_message", async (payload) => {
      const start = Date.now();

      log("CHAT", "SEND_START", {
        requestId,
        payload,
      });

      try {
        const { corsa_id, cliente_id, text, client_msg_id } = payload;

        const trimmed = text?.trim();
        if (!trimmed) {
          log("CHAT", "EMPTY_BLOCKED", { requestId });
          return;
        }

        /* ================= THREAD CHECK ================= */

        const threadRes = await pool.query(
          `
          SELECT driver_id, cliente_id
          FROM chat_threads
          WHERE corsa_id=$1 AND cliente_id=$2
          `,
          [corsa_id, cliente_id]
        );

        const thread = threadRes.rows[0];

        if (!thread) {
          log("CHAT", "THREAD_NOT_FOUND", {
            requestId,
            corsa_id,
            cliente_id,
          });
          return;
        }

        /* ================= INSERT MESSAGE ================= */

        const msgKey = client_msg_id || crypto.randomUUID();

        const msgRes = await pool.query(
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

        const msg = msgRes.rows[0];

        const normalizedMsg = {
          ...msg,
          created_at: Number(msg.created_at),
        };

        log("CHAT", "MESSAGE_INSERTED", {
          requestId,
          msgId: msg.id,
        });

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
              created_at: normalizedMsg.created_at,
            }),
          ]
        );

        log("CHAT", "THREAD_UPDATED", { requestId });

        /* ================= EMIT MESSAGE ================= */

        const room = `chat_${corsa_id}_${cliente_id}`;

        io.to(room).emit("new_message", normalizedMsg);

        log("SOCKET", "NEW_MESSAGE_EMITTED", {
          requestId,
          room,
          msgId: msg.id,
        });

        /* ================= DELIVERY ================= */

        const recipientId =
          role === "cliente" ? thread.driver_id : cliente_id;

        const recipientRole =
          role === "cliente" ? "autista" : "cliente";

        const recipientRoom = `${recipientRole}_${recipientId}`;

        const clients = io.sockets.adapter.rooms.get(recipientRoom);

        log("SOCKET", "RECIPIENT_CHECK", {
          requestId,
          recipientRoom,
          online: clients?.size || 0,
        });

        if (clients?.size > 0) {
          await pool.query(
            `
            INSERT INTO message_receipts (
              message_id,
              user_id,
              delivered_at
            )
            VALUES ($1,$2,NOW())
            ON CONFLICT DO NOTHING
            `,
            [msg.id, recipientId]
          );

          io.to(recipientRoom).emit("message_delivered", {
            message_id: msg.id,
            corsa_id,
            cliente_id,
            delivered_at: Date.now(),
          });

          log("SOCKET", "DELIVERED_EMIT", {
            requestId,
            recipientRoom,
            msgId: msg.id,
          });
        }

        log("CHAT", "SEND_SUCCESS", {
          requestId,
          durationMs: Date.now() - start,
        });
      } catch (err) {
        log("ERROR", "SEND_FAILED", {
          requestId,
          message: err.message,
          stack: err.stack,
        });
      }
    });

    /* ================= READ ================= */

    socket.on("mark_as_read", async ({ corsa_id, cliente_id }) => {
      const start = Date.now();

      log("CHAT", "READ_START", {
        requestId,
        corsa_id,
        cliente_id,
      });

      try {
        const res = await pool.query(
          `
          UPDATE message_receipts mr
          SET read_at=NOW()
          FROM messaggi m
          WHERE m.id = mr.message_id
          AND m.corsa_id=$1
          AND m.cliente_id=$2
          AND mr.user_id=$3
          RETURNING m.id
          `,
          [corsa_id, cliente_id, userId]
        );

        const messageIds = res.rows.map((r) => r.id);

        await pool.query(
          `
          UPDATE chat_threads
          SET unreadcount=0
          WHERE corsa_id=$1 AND cliente_id=$2
          `,
          [corsa_id, cliente_id]
        );

        const room = `chat_${corsa_id}_${cliente_id}`;

        io.to(room).emit("message_read", {
          message_ids: messageIds,
          corsa_id,
          cliente_id,
          reader_id: userId,
          read_at: Date.now(),
        });

        log("SOCKET", "READ_EMIT", {
          requestId,
          room,
          count: messageIds.length,
        });

        log("CHAT", "READ_SUCCESS", {
          requestId,
          durationMs: Date.now() - start,
        });
      } catch (err) {
        log("ERROR", "READ_FAILED", {
          requestId,
          message: err.message,
        });
      }
    });

    socket.on("disconnect", (reason) => {
      log("SOCKET", "DISCONNECT", {
        requestId,
        userId,
        role,
        reason,
      });
    });
  });
};