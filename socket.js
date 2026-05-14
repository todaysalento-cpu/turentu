import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import { getCorseCache } from "./services/search/search.cache.js";

let io;

/* ===================== IO ===================== */
const getIO = () => {
  if (!io) throw new Error("Socket.io non inizializzato!");
  return io;
};

/* ===================== EMIT HELPERS ===================== */
const emitNuovaCorsa = (driverId, corsa) => {
  if (!io) return;
  io.to(`autista_${driverId}`).emit("nuova_corsa", corsa);
};

const emitCorsaUpdate = (corsa) => {
  if (!io) return;
  io.to(`corsa_${corsa.id}`).emit("corsaUpdate", corsa);
};

const sendNotification = ({ userId, role, notification }) => {
  if (!io) return;
  if (!userId || !role || !notification) return;

  io.to(`${role}_${userId}`).emit("new_notification", notification);
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

    const joinedRooms = new Set();
    const sentInitChats = new Set();
    const sentMessages = new Set();

    /* ===================== PERSONAL ROOM ===================== */
    const personalRoom = `${role}_${userId}`;
    socket.join(personalRoom);
    joinedRooms.add(personalRoom);

    /* ===================== AUTISTA ROOMS ===================== */
    if (role === "autista") {
      try {
        const corseCache = await getCorseCache();

        for (const c of corseCache) {
          if (Number(c.driver_id) !== Number(userId)) continue;

          const room = `corsa_${c.id}`;
          socket.join(room);
          joinedRooms.add(room);
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
      joinedRooms.add(room);

      const chatKey = `init_${corsaId}_${clienteId}`;
      if (sentInitChats.has(chatKey)) return;
      sentInitChats.add(chatKey);

      try {
        const { rows } = await pool.query(
          `
          SELECT
            id,
            corsa_id,
            cliente_id,
            sender_id,
            testo AS text,
            created_at,
            read_status,
            client_msg_id
          FROM messaggi
          WHERE corsa_id = $1
            AND cliente_id = $2
          ORDER BY created_at ASC
          LIMIT 30
          `,
          [corsaId, clienteId]
        );

        socket.emit("init_chat", {
          corsa_id: corsaId,
          cliente_id: clienteId,
          messages: rows,
        });
      } catch (err) {
        console.error("❌ join_chat error:", err);
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

      const msgKey = client_msg_id || `${userId}_${Date.now()}_${Math.random()}`;

      if (sentMessages.has(msgKey)) return;
      sentMessages.add(msgKey);

      try {
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
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            jsonb_build_object(
              'autista',
              CASE WHEN $3 = (
                SELECT v.driver_id
                FROM corse c
                JOIN veicolo v ON v.id = c.veicolo_id
                WHERE c.id = $1
              ) THEN true ELSE false END,
              'cliente',
              CASE WHEN $3 != (
                SELECT v.driver_id
                FROM corse c
                JOIN veicolo v ON v.id = c.veicolo_id
                WHERE c.id = $1
              ) THEN true ELSE false END
            )
          )
          ON CONFLICT (client_msg_id) DO NOTHING
          RETURNING
            id,
            corsa_id,
            cliente_id,
            sender_id,
            testo AS text,
            created_at,
            read_status,
            client_msg_id
          `,
          [corsaId, clienteId, userId, text.trim(), msgKey]
        );

        if (!rows.length) return;

        const msg = rows[0];

        io.to(room).emit("new_message", msg);

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

    socket.on("disconnect", (reason) => {
      console.log("❌ DISCONNECT", { socketId: socket.id, userId, reason });
    });
  });
};

export {
  setupSocket,
  getIO,
  sendNotification,
  emitNuovaCorsa,
  emitCorsaUpdate,
};