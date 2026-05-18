import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import crypto from "crypto";

let io;

/* ================= IO ================= */

export const getIO = () => {
  if (!io) throw new Error("Socket.io non inizializzato!");
  return io;
};

/* ================= LOGGER ================= */

const log = (label, data = {}) => {
  console.log(
    JSON.stringify(
      {
        time: new Date().toISOString(),
        label,
        ...data,
      },
      null,
      2
    )
  );
};

/* ================= NOTIFICATION ================= */

export const sendNotification = ({ userId, role, notification }) => {
  if (!io || !userId || !role || !notification) return;

  const room = `${role}_${userId}`;

  io.to(room).emit("new_notification", {
    ...notification,
    sentAt: Date.now(),
  });

  log("NOTIFICATION_SENT", {
    room,
    userId,
    role,
  });
};

/* ================= SOCKET SETUP ================= */

export const setupSocket = (ioServer) => {
  io = ioServer;

  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";

  /* ================= AUTH ================= */

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
      log("AUTH_NO_TOKEN");
      return next(new Error("NO_TOKEN"));
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);

      decoded.role = decoded.role?.toLowerCase() || "cliente";

      socket.user = decoded;

      log("AUTH_OK", {
        id: decoded.id,
        role: decoded.role,
      });

      next();
    } catch (err) {
      log("AUTH_FAILED", {
        error: err.message,
      });

      next(new Error("JWT_INVALID"));
    }
  });

  /* ================= CONNECTION ================= */

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user;

    socket.join(`${role}_${userId}`);

    log("SOCKET_CONNECTED", {
      userId,
      role,
      socketId: socket.id,
    });

    /* ================= JOIN CHAT ================= */

    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      try {
        const cId = Number(corsa_id);
        const clId = Number(cliente_id);

        log("JOIN_CHAT_RECEIVED", {
          userId,
          cId,
          clId,
        });

        if (!cId || !clId) {
          log("JOIN_CHAT_INVALID_IDS", {
            cId,
            clId,
          });

          return;
        }

        const room = `chat_${cId}_${clId}`;

        socket.join(room);

        log("JOIN_CHAT_ROOM", {
          room,
          socketRooms: [...socket.rooms],
        });

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
          [cId, clId, userId]
        );

        log("JOIN_CHAT_MESSAGES_LOADED", {
          room,
          count: rows.length,
          firstMessage: rows[0]?.id,
          lastMessage: rows[rows.length - 1]?.id,
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
          corsa_id: cId,
          cliente_id: clId,
          messages,
        });

        log("INIT_CHAT_SENT", {
          room,
          messagesCount: messages.length,
        });
      } catch (err) {
        log("INIT_CHAT_FAILED", {
          error: err.message,
          stack: err.stack,
        });
      }
    });

    /* ================= SEND MESSAGE ================= */

    socket.on("send_message", async (payload) => {
      try {
        const { corsa_id, cliente_id, text, client_msg_id } = payload;

        const cId = Number(corsa_id);
        const clId = Number(cliente_id);

        const trimmed = text?.trim();

        log("SEND_MESSAGE_RECEIVED", {
          userId,
          role,
          cId,
          clId,
          text: trimmed,
          client_msg_id,
        });

        if (!trimmed) {
          log("SEND_MESSAGE_EMPTY");
          return;
        }

        const threadRes = await pool.query(
          `
          SELECT driver_id
          FROM chat_threads
          WHERE corsa_id=$1 AND cliente_id=$2
          `,
          [cId, clId]
        );

        const thread = threadRes.rows[0];

        if (!thread) {
          log("THREAD_NOT_FOUND", {
            cId,
            clId,
          });

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
          [cId, clId, userId, trimmed, msgKey]
        );

        const msg = msgRes.rows[0];

        log("MESSAGE_INSERTED", {
          messageId: msg.id,
          sender_id: userId,
        });

        const recipientId =
          role === "cliente"
            ? thread.driver_id
            : clId;

        const room = `chat_${cId}_${clId}`;

        io.to(room).emit("new_message", {
          id: String(msg.id),
          corsa_id: cId,
          cliente_id: clId,
          sender_id: userId,
          text: trimmed,
          client_msg_id: msgKey,
          created_at: Number(new Date(msg.created_at)),
          status: {
            sent: true,
            delivered: false,
            read: false,
          },
        });

        log("NEW_MESSAGE_EMITTED", {
          room,
          messageId: msg.id,
        });

        /* ================= DELIVERY ================= */

        const recipientRole =
          role === "cliente"
            ? "autista"
            : "cliente";

        const recipientRoom = `${recipientRole}_${recipientId}`;

        const clients =
          io.sockets.adapter.rooms.get(recipientRoom);

        log("DELIVERY_CHECK", {
          recipientRoom,
          recipientId,
          onlineClients: clients?.size || 0,
        });

        if (clients?.size > 0) {
          await pool.query(
            `
            INSERT INTO message_receipts (
              message_id,
              user_id,
              delivered_at,
              read_at
            )
            VALUES ($1,$2,NOW(),NULL)
            ON CONFLICT (message_id, user_id)
            DO UPDATE SET delivered_at = NOW()
            `,
            [msg.id, recipientId]
          );

          io.to(recipientRoom).emit("message_delivered", {
            message_id: String(msg.id),
            corsa_id: cId,
            cliente_id: clId,
            delivered_at: Date.now(),
          });

          log("MESSAGE_DELIVERED", {
            recipientRoom,
            messageId: msg.id,
          });
        } else {
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

          log("RECIPIENT_OFFLINE", {
            recipientRoom,
            messageId: msg.id,
          });
        }
      } catch (err) {
        log("SEND_FAILED", {
          error: err.message,
          stack: err.stack,
        });
      }
    });

    /* ================= MARK AS READ ================= */

    socket.on("mark_as_read", async ({ message_ids = [] }) => {
      try {
        const ids = (Array.isArray(message_ids)
          ? message_ids
          : []
        )
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id));

        log("MARK_AS_READ_RECEIVED", {
          userId,
          totalIds: ids.length,
          idsSample: ids.slice(0, 10),
        });

        if (!ids.length) {
          log("MARK_AS_READ_EMPTY");
          return;
        }

        const updateRes = await pool.query(
          `
          UPDATE message_receipts
          SET read_at = NOW()
          WHERE message_id = ANY($1::int[])
            AND user_id = $2
            AND read_at IS NULL
          RETURNING message_id
          `,
          [ids, userId]
        );

        log("MARK_AS_READ_UPDATED", {
          updatedCount: updateRes.rows.length,
          updatedIds: updateRes.rows.map((r) => r.message_id),
        });

        const { rows } = await pool.query(
          `
          SELECT message_id
          FROM message_receipts
          WHERE message_id = ANY($1::int[])
            AND user_id = $2
            AND read_at IS NOT NULL
          `,
          [ids, userId]
        );

        const messageIds = rows.map((r) =>
          String(r.message_id)
        );

        const rooms = [...socket.rooms].filter((r) =>
          r.startsWith("chat_")
        );

        log("MARK_AS_READ_ROOMS", {
          rooms,
          confirmedIds: messageIds,
        });

        for (const room of rooms) {
          io.to(room).emit("message_read", {
            message_ids: messageIds,
            reader_id: userId,
            read_at: Date.now(),
          });

          log("MESSAGE_READ_EMITTED", {
            room,
            count: messageIds.length,
          });
        }
      } catch (err) {
        log("READ_FAILED", {
          error: err.message,
          stack: err.stack,
        });
      }
    });

    /* ================= DISCONNECT ================= */

    socket.on("disconnect", (reason) => {
      log("SOCKET_DISCONNECT", {
        userId,
        role,
        reason,
      });
    });
  });
};