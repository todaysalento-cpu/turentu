import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import crypto from "crypto";

let io;

/* =========================================================
   LOGGER
========================================================= */

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

/* =========================================================
   IO ACCESS
========================================================= */

export const getIO = () => {
  if (!io) {
    log("ERROR", "SOCKET IO NON INIZIALIZZATO");
    throw new Error("Socket.io non inizializzato!");
  }

  return io;
};

/* =========================================================
   NOTIFICATIONS
========================================================= */

export const sendNotification = ({
  userId,
  role,
  notification,
}) => {

  if (!io) {
    log("WARN", "NOTIFICATION SKIPPED - IO NULL");
    return;
  }

  const room = `${role}_${userId}`;

  log("NOTIFICATION", "SEND", {
    room,
    userId,
    role,
    notification,
  });

  io.to(room).emit(
    "new_notification",
    notification
  );
};

/* =========================================================
   SOCKET SETUP
========================================================= */

export const setupSocket = (ioServer) => {

  io = ioServer;

  const JWT_SECRET =
    process.env.JWT_SECRET || "segreto-di-test";

  log("SOCKET", "SOCKET SERVER INIT");

  /* =========================================================
     AUTH
  ========================================================= */

  io.use((socket, next) => {

    const requestId = crypto.randomUUID();

    socket.requestId = requestId;

    log("AUTH", "SOCKET AUTH START", {
      requestId,
      socketId: socket.id,
      hasToken: !!socket.handshake.auth?.token,
    });

    const token = socket.handshake.auth?.token;

    if (!token) {

      log("AUTH", "TOKEN MANCANTE", {
        requestId,
        socketId: socket.id,
      });

      return next(new Error("NO_TOKEN"));
    }

    try {

      const decoded = jwt.verify(
        token,
        JWT_SECRET
      );

      decoded.role =
        decoded.role?.toLowerCase();

      socket.user = decoded;

      log("AUTH", "SOCKET AUTH OK", {
        requestId,
        socketId: socket.id,
        user: {
          id: decoded.id,
          role: decoded.role,
        },
      });

      next();

    } catch (err) {

      log("ERROR", "JWT INVALID", {
        requestId,
        socketId: socket.id,
        message: err.message,
        stack: err.stack,
      });

      next(new Error("JWT_INVALID"));
    }
  });

  /* =========================================================
     CONNECTION
  ========================================================= */

  io.on("connection", (socket) => {

    const requestId = socket.requestId;

    const {
      id: userId,
      role,
    } = socket.user;

    log("SOCKET", "CLIENT CONNECTED", {
      requestId,
      socketId: socket.id,
      userId,
      role,
    });

    const userRoom = `${role}_${userId}`;
    const threadsRoom = `threads_${role}_${userId}`;

    socket.join(userRoom);
    socket.join(threadsRoom);

    log("ROOM", "USER JOINED ROOMS", {
      requestId,
      socketId: socket.id,
      rooms: [userRoom, threadsRoom],
    });

    /* =========================================================
       JOIN CHAT
    ========================================================= */

    socket.on(
      "join_chat",
      ({ corsa_id, cliente_id }) => {

        log("CHAT", "JOIN_CHAT REQUEST", {
          requestId,
          socketId: socket.id,
          corsa_id,
          cliente_id,
        });

        if (!corsa_id || !cliente_id) {

          log("WARN", "JOIN_CHAT PARAMS INVALID", {
            requestId,
            payload: {
              corsa_id,
              cliente_id,
            },
          });

          return;
        }

        const room =
          `chat_${corsa_id}_${cliente_id}`;

        socket.join(room);

        log("ROOM", "CHAT ROOM JOINED", {
          requestId,
          socketId: socket.id,
          room,
        });
      }
    );

    /* =========================================================
       SEND MESSAGE
    ========================================================= */

    socket.on(
      "send_message",
      async (payload) => {

        const startedAt = Date.now();

        log("CHAT", "SEND_MESSAGE START", {
          requestId,
          socketId: socket.id,
          payload,
        });

        const {
          corsa_id,
          cliente_id,
          text,
          client_msg_id,
        } = payload;

        const trimmed = text?.trim();

        if (!trimmed) {

          log("WARN", "EMPTY MESSAGE BLOCKED", {
            requestId,
            payload,
          });

          return;
        }

        try {

          /* ================= THREAD CHECK ================= */

          const threadQuery = `
            SELECT driver_id, cliente_id
            FROM chat_threads
            WHERE corsa_id=$1
            AND cliente_id=$2
          `;

          log("DB", "THREAD CHECK QUERY", {
            requestId,
            query: threadQuery,
            params: [corsa_id, cliente_id],
          });

          const { rows: threadRows } =
            await pool.query(
              threadQuery,
              [corsa_id, cliente_id]
            );

          log("DB", "THREAD CHECK RESULT", {
            requestId,
            rows: threadRows,
          });

          const thread = threadRows[0];

          if (!thread) {

            log("WARN", "THREAD NOT FOUND", {
              requestId,
              corsa_id,
              cliente_id,
            });

            return;
          }

          const msgKey =
            client_msg_id ||
            crypto.randomUUID();

          log("CHAT", "MESSAGE KEY GENERATED", {
            requestId,
            msgKey,
          });

          /* ================= INSERT MESSAGE ================= */

          const insertQuery = `
            INSERT INTO messaggi (
              corsa_id,
              cliente_id,
              sender_id,
              testo,
              client_msg_id
            )
            VALUES ($1,$2,$3,$4,$5)
            RETURNING *
          `;

          log("DB", "INSERT MESSAGE QUERY", {
            requestId,
            query: insertQuery,
            params: [
              corsa_id,
              cliente_id,
              userId,
              trimmed,
              msgKey,
            ],
          });

          const { rows } = await pool.query(
            insertQuery,
            [
              corsa_id,
              cliente_id,
              userId,
              trimmed,
              msgKey,
            ]
          );

          const msg = rows[0];

          log("DB", "MESSAGE INSERTED", {
            requestId,
            msg,
          });

          const normalizedMsg = {
            ...msg,
            created_at: Number(
              msg.created_at
            ),
          };

          /* ================= UPDATE THREAD ================= */

          const updateThreadQuery = `
            UPDATE chat_threads
            SET
              last_message = $3::jsonb,
              updated_at = NOW()
            WHERE corsa_id=$1
            AND cliente_id=$2
          `;

          const lastMessagePayload = {
            text: trimmed,
            created_at:
              normalizedMsg.created_at,
          };

          log("DB", "UPDATE THREAD QUERY", {
            requestId,
            query: updateThreadQuery,
            params: [
              corsa_id,
              cliente_id,
              lastMessagePayload,
            ],
          });

          await pool.query(
            updateThreadQuery,
            [
              corsa_id,
              cliente_id,
              JSON.stringify(
                lastMessagePayload
              ),
            ]
          );

          log("DB", "THREAD UPDATED", {
            requestId,
            corsa_id,
            cliente_id,
          });

          /* ================= EMIT MESSAGE ================= */

          const chatRoom =
            `chat_${corsa_id}_${cliente_id}`;

          log("SOCKET", "EMIT NEW_MESSAGE", {
            requestId,
            room: chatRoom,
            message: normalizedMsg,
          });

          io.to(chatRoom).emit(
            "new_message",
            normalizedMsg
          );

          /* ================= DELIVERY ================= */

          const recipientId =
            role === "cliente"
              ? thread.driver_id
              : cliente_id;

          const recipientRole =
            role === "cliente"
              ? "autista"
              : "cliente";

          const recipientRoom =
            `${recipientRole}_${recipientId}`;

          const clients =
            io.sockets.adapter.rooms.get(
              recipientRoom
            );

          log("SOCKET", "RECIPIENT CHECK", {
            requestId,
            recipientRoom,
            onlineClients:
              clients?.size || 0,
          });

          const deliveredAt = Date.now();

          if (clients && clients.size > 0) {

            const receiptQuery = `
              INSERT INTO message_receipts (
                message_id,
                user_id,
                delivered_at
              )
              VALUES ($1,$2,NOW())
              ON CONFLICT (message_id, user_id)
              DO UPDATE
              SET delivered_at =
                COALESCE(
                  message_receipts.delivered_at,
                  NOW()
                )
            `;

            log("DB", "INSERT RECEIPT QUERY", {
              requestId,
              query: receiptQuery,
              params: [
                msg.id,
                recipientId,
              ],
            });

            await pool.query(
              receiptQuery,
              [msg.id, recipientId]
            );

            log("DB", "MESSAGE DELIVERED", {
              requestId,
              messageId: msg.id,
              recipientId,
            });

            io.to(recipientRoom).emit(
              "message_delivered",
              {
                message_id: msg.id,
                corsa_id,
                cliente_id,
                delivered_at: deliveredAt,
              }
            );

            log("SOCKET", "EMIT MESSAGE_DELIVERED", {
              requestId,
              room: recipientRoom,
              messageId: msg.id,
            });
          }

          log("CHAT", "SEND_MESSAGE SUCCESS", {
            requestId,
            durationMs:
              Date.now() - startedAt,
          });

        } catch (err) {

          log("ERROR", "SEND_MESSAGE ERROR", {
            requestId,
            message: err.message,
            stack: err.stack,
            payload,
          });
        }
      }
    );

    /* =========================================================
       MARK AS READ
    ========================================================= */

    socket.on(
      "mark_as_read",
      async ({
        corsa_id,
        cliente_id,
      }) => {

        const startedAt = Date.now();

        log("CHAT", "MARK_AS_READ START", {
          requestId,
          corsa_id,
          cliente_id,
          userId,
        });

        try {

          if (!corsa_id || !cliente_id) {

            log("WARN", "READ PARAMS INVALID", {
              requestId,
              corsa_id,
              cliente_id,
            });

            return;
          }

          const readQuery = `
            UPDATE message_receipts mr
            SET read_at = NOW()
            FROM messaggi m
            WHERE m.id = mr.message_id
              AND m.corsa_id = $1
              AND m.cliente_id = $2
              AND mr.user_id = $3
              AND mr.read_at IS NULL
            RETURNING m.id
          `;

          log("DB", "MARK READ QUERY", {
            requestId,
            query: readQuery,
            params: [
              corsa_id,
              cliente_id,
              userId,
            ],
          });

          const { rows } = await pool.query(
            readQuery,
            [
              corsa_id,
              cliente_id,
              userId,
            ]
          );

          const messageIds =
            rows.map((r) => r.id);

          log("DB", "MESSAGES READ", {
            requestId,
            count: messageIds.length,
            messageIds,
          });

          /* ================= RESET UNREAD ================= */

          const unreadQuery = `
            UPDATE chat_threads
            SET unreadcount = 0
            WHERE corsa_id=$1
            AND cliente_id=$2
          `;

          log("DB", "RESET UNREAD QUERY", {
            requestId,
            query: unreadQuery,
            params: [
              corsa_id,
              cliente_id,
            ],
          });

          await pool.query(
            unreadQuery,
            [
              corsa_id,
              cliente_id,
            ]
          );

          log("DB", "UNREAD RESET DONE", {
            requestId,
          });

          const payload = {
            message_ids: messageIds,
            corsa_id,
            cliente_id,
            reader_id: userId,
            read_at: Date.now(),
          };

          io.to(
            `chat_${corsa_id}_${cliente_id}`
          ).emit(
            "message_read",
            payload
          );

          log("SOCKET", "EMIT MESSAGE_READ", {
            requestId,
            payload,
          });

          log("CHAT", "MARK_AS_READ SUCCESS", {
            requestId,
            durationMs:
              Date.now() - startedAt,
          });

        } catch (err) {

          log("ERROR", "MARK_AS_READ ERROR", {
            requestId,
            message: err.message,
            stack: err.stack,
          });
        }
      }
    );

    /* =========================================================
       DISCONNECT
    ========================================================= */

    socket.on("disconnect", (reason) => {

      log("SOCKET", "CLIENT DISCONNECTED", {
        requestId,
        socketId: socket.id,
        userId,
        role,
        reason,
      });
    });
  });
};