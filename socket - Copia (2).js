// ======================= socket.js =======================
import jwt from "jsonwebtoken";
import { pool } from "./db/db.js";
import { getCorseCache } from "./services/search/search.cache.js";

let io;

// =======================
// Getter io
// =======================
const getIO = () => {
  if (!io) throw new Error("Socket.io non inizializzato!");
  return io;
};

// =======================
// EMIT HELPERS
// =======================

// 👉 nuova corsa
const emitNuovaCorsa = (driverId, corsa) => {
  if (!io) return;

  console.log("🚀 EMIT nuova_corsa -> autista", driverId, corsa.id);

  io.to(`autista_${driverId}`).emit("nuova_corsa", corsa);
};

// 👉 update corsa
const emitCorsaUpdate = (corsa) => {
  if (!io) return;

  console.log("🔄 EMIT corsaUpdate", corsa.id);

  io.to(`corsa_${corsa.id}`).emit("corsaUpdate", corsa);
};

// 👉 pending update
const emitPendingUpdate = (driverId, pending) => {
  if (!io) return;

  io.to(`autista_${driverId}`).emit("pending_update", pending);
};

// 👉 new pending
const emitNewPending = (driverId, pending) => {
  if (!io) return;

  io.to(`autista_${driverId}`).emit("new_pending", { pending });
};

// 👉 NOTIFICATIONS (🔥 FIX CRITICO MANCANTE)
const sendNotification = ({ userId, role, notification }) => {
  if (!io) return;

  if (!userId || !role || !notification) return;

  console.log("🔔 NOTIFICATION ->", role, userId);

  io.to(`${role}_${userId}`).emit("new_notification", notification);
};

// =======================
// SOCKET SETUP
// =======================
const setupSocket = (ioServer) => {
  io = ioServer;

  const JWT_SECRET = process.env.JWT_SECRET || "segreto-di-test";
  const isDev = process.env.NODE_ENV !== "production";

  // =======================
  // AUTH
  // =======================
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
      console.log("❌ SOCKET NO TOKEN");
      return next(new Error("NO_TOKEN"));
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);

      decoded.role = ["autista", "cliente"].includes(decoded.role?.toLowerCase())
        ? decoded.role.toLowerCase()
        : "cliente";

      socket.user = decoded;

      console.log("🟢 SOCKET AUTH OK:", decoded.id);

      next();
    } catch (err) {
      console.log("❌ SOCKET JWT ERROR:", err.message);
      return next(new Error("JWT_INVALID"));
    }
  });

  // =======================
  // CONNECTION
  // =======================
  io.on("connection", async (socket) => {
    const { id: userId, role } = socket.user;

    const joinedRooms = new Set();

    console.log("🔌 CONNECTED:", socket.id, userId, role);

    // room personale
    const personalRoom = `${role}_${userId}`;
    socket.join(personalRoom);
    joinedRooms.add(personalRoom);

    console.log("🏠 JOIN PERSONAL ROOM:", personalRoom);

    // =======================
    // AUTISTA → CORSE
    // =======================
    if (role === "autista") {
      try {
        const corseCache = await getCorseCache();

        const corse = corseCache.filter(
          (c) => Number(c.driver_id) === Number(userId)
        );

        console.log(`🚗 corse autista: ${corse.length}`);

        for (const corsa of corse) {
          const room = `corsa_${corsa.id}`;

          if (!joinedRooms.has(room)) {
            socket.join(room);
            joinedRooms.add(room);

            console.log("✈️ join:", room);
          }
        }
      } catch (err) {
        console.error("❌ errore corse:", err);
      }
    }

    // =======================
    // CHAT
    // =======================
    socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
      const corsaIdNum = Number(corsa_id);
      const clienteIdNum = Number(cliente_id);

      if (!corsaIdNum || !clienteIdNum) return;

      const room = `chat_${corsaIdNum}_${clienteIdNum}`;

      socket.join(room);

      try {
        const { rows } = await pool.query(
          `SELECT id, corsa_id, cliente_id, sender_id,
                  testo AS text,
                  created_at AS timestamp,
                  read_status
           FROM messaggi
           WHERE corsa_id=$1 AND cliente_id=$2
           ORDER BY created_at ASC`,
          [corsaIdNum, clienteIdNum]
        );

        socket.emit("init_chat", {
          corsa_id: corsaIdNum,
          cliente_id: clienteIdNum,
          messages: rows,
        });
      } catch (err) {
        console.error("❌ chat error:", err);
      }
    });

    // =======================
    // MESSAGE
    // =======================
    socket.on("send_message", async ({ corsa_id, cliente_id, text }) => {
      if (!text?.trim()) return;

      const room = `chat_${corsa_id}_${cliente_id}`;

      try {
        const { rows } = await pool.query(
          `INSERT INTO messaggi
           (corsa_id, cliente_id, sender_id, testo, created_at)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING *`,
          [corsa_id, cliente_id, userId, text.trim(), new Date()]
        );

        io.to(room).emit("new_message", rows[0]);
      } catch (err) {
        console.error("❌ send_message:", err);
      }
    });

    // =======================
    // DISCONNECT
    // =======================
    socket.on("disconnect", (reason) => {
      console.log("❌ DISCONNECT:", socket.id, reason);
    });
  });
};

// =======================
export {
  setupSocket,
  getIO,
  sendNotification,
  emitNuovaCorsa,
  emitCorsaUpdate,
  emitPendingUpdate,
  emitNewPending,
};