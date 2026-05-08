import express from 'express';
import { pool } from '../db/db.js';
import jwt from 'jsonwebtoken';

const chatRouter = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';


// ======================= AUTH =======================
const authMiddleware = (req, res, next) => {
  try {
    const token =
      req.headers.authorization?.split(' ')[1] ||
      req.cookies?.token;

    if (!token) {
      console.log("⛔ [AUTH] missing token");
      return res.status(401).json({ message: 'No token' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    decoded.role = decoded.role.toLowerCase();

    console.log("🔐 [AUTH OK]", { id: decoded.id, role: decoded.role });

    req.user = decoded;
    next();
  } catch (err) {
    console.error('❌ [AUTH ERROR]', err.message);
    return res.status(401).json({ message: 'Invalid token' });
  }
};


// ======================= INIT CHAT =======================
chatRouter.get('/init', authMiddleware, async (req, res) => {
  const { id: userIdRaw, role } = req.user;
  const userId = Number(userIdRaw);

  console.log("\n🟡 [CHAT INIT START]", { userId, role });

  const MESSAGE_LIMIT = 30;

  try {
    let rows = [];

    // ================= AUTISTA =================
    if (role === 'autista') {
      console.log("🚗 [INIT] AUTISTA");

      const result = await pool.query(
        `SELECT
          c.id AS corsa_id,
          p.cliente_id,
          c.origine_address,
          c.destinazione_address,
          c.start_datetime
        FROM corse c
        INNER JOIN veicolo v ON v.id = c.veicolo_id
        INNER JOIN prenotazioni p ON p.corsa_id = c.id
        WHERE v.driver_id = $1
        GROUP BY c.id, p.cliente_id, c.origine_address, c.destinazione_address, c.start_datetime
        ORDER BY c.start_datetime DESC`,
        [userId]
      );

      console.log("📦 [INIT AUTISTA ROWS]", result.rows.length);

      rows = result.rows;
    }

    // ================= CLIENTE =================
    else if (role === 'cliente') {
      console.log("👤 [INIT] CLIENTE");

      const result = await pool.query(
        `SELECT
          c.id AS corsa_id,
          p.cliente_id,
          c.origine_address,
          c.destinazione_address,
          c.start_datetime
        FROM prenotazioni p
        INNER JOIN corse c ON c.id = p.corsa_id
        WHERE p.cliente_id = $1
        GROUP BY c.id, p.cliente_id, c.origine_address, c.destinazione_address, c.start_datetime
        ORDER BY c.start_datetime DESC`,
        [userId]
      );

      console.log("📦 [INIT CLIENTE ROWS]", result.rows.length);

      rows = result.rows;
    }

    console.log("🧵 [INIT TOTAL ROWS]", rows.length);

    const threads = await Promise.all(
      rows.map(async (r) => {
        const corsaId = Number(r.corsa_id);
        const clienteId = Number(r.cliente_id);

        const chatId = `${corsaId}_${clienteId}`;

        console.log("🔹 [THREAD BUILD]", chatId);

        const { rows: unread } = await pool.query(
          `SELECT COUNT(*)::int AS count
           FROM messaggi
           WHERE corsa_id = $1
             AND cliente_id = $2
             AND sender_id != $3`,
          [corsaId, clienteId, userId]
        );

        const { rows: messages } = await pool.query(
          `SELECT id, corsa_id, cliente_id, sender_id, testo AS text, created_at
           FROM messaggi
           WHERE corsa_id = $1 AND cliente_id = $2
           ORDER BY created_at DESC
           LIMIT $3`,
          [corsaId, clienteId, MESSAGE_LIMIT]
        );

        console.log("💬 [THREAD MSG]", {
          chatId,
          messages: messages.length
        });

        return {
          id: chatId,
          corsa_id: corsaId,
          cliente_id: clienteId,
          origine: r.origine_address || '',
          destinazione: r.destinazione_address || '',
          start_datetime: r.start_datetime,
          unreadCount: unread?.[0]?.count || 0,
          messages: messages.reverse(),
          hasMore: messages.length === MESSAGE_LIMIT,
        };
      })
    );

    console.log("✅ [CHAT INIT DONE]", {
      threads: threads.length
    });

    return res.json(threads);

  } catch (err) {
    console.error('❌ [INIT CHAT ERROR]', err);
    return res.status(500).json({ message: 'Errore init chat' });
  }
});


// ======================= PAGINATION =======================
chatRouter.get('/messages', authMiddleware, async (req, res) => {
  const { corsa_id, cliente_id, cursor, limit = 30 } = req.query;

  console.log("\n📥 [PAGINATION REQUEST]", {
    corsa_id,
    cliente_id,
    cursor
  });

  try {
    const values = [corsa_id, cliente_id, Number(limit)];

    let cursorQuery = '';

    if (cursor) {
      values.push(cursor);
      cursorQuery = `AND created_at < $4`;
    }

    const { rows } = await pool.query(
      `SELECT id, corsa_id, cliente_id, sender_id, testo AS text, created_at
       FROM messaggi
       WHERE corsa_id = $1 AND cliente_id = $2
       ${cursorQuery}
       ORDER BY created_at DESC
       LIMIT $3`,
      values
    );

    console.log("📦 [PAGINATION RESULT]", rows.length);

    return res.json({
      messages: rows.reverse(),
      hasMore: rows.length === Number(limit),
      nextCursor: rows.length ? rows[rows.length - 1].created_at : null,
    });

  } catch (err) {
    console.error("❌ [PAGINATION ERROR]", err);
    return res.status(500).json({ message: 'error' });
  }
});


// ======================= SOCKET =======================
export const attachChatSocket = (io) => {

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        console.log("⛔ [SOCKET] no token");
        return next(new Error('no token'));
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      decoded.role = decoded.role.toLowerCase();

      socket.user = decoded;

      console.log("🔐 [SOCKET AUTH OK]", decoded.id);

      next();
    } catch (err) {
      console.error("❌ [SOCKET AUTH FAIL]", err.message);
      next(new Error('invalid token'));
    }
  });

  io.on('connection', (socket) => {

    console.log('📡 [SOCKET CONNECTED]', {
      socket: socket.id,
      user: socket.user?.id
    });

    // ================= JOIN CHAT =================
    socket.on('join_chat', async ({ corsa_id, cliente_id }) => {

      console.log("📥 [JOIN CHAT]", { corsa_id, cliente_id });

      try {
        const userId = Number(socket.user.id);

        const access = await pool.query(
          `SELECT 1
           FROM prenotazioni p
           INNER JOIN corse c ON c.id = p.corsa_id
           LEFT JOIN veicolo v ON v.id = c.veicolo_id
           WHERE p.corsa_id = $1
             AND p.cliente_id = $2
             AND (p.cliente_id = $3 OR v.driver_id = $3)`,
          [corsa_id, cliente_id, userId]
        );

        if (!access.rows.length) {
          console.log("⛔ [JOIN DENIED]");
          return;
        }

        const room = `chat_${corsa_id}_${cliente_id}`;

        socket.join(room);

        console.log("🏠 [JOINED ROOM]", room);

      } catch (err) {
        console.error("❌ [JOIN ERROR]", err);
      }
    });

    // ================= SEND MESSAGE =================
    socket.on('send_message', async ({ corsa_id, cliente_id, text }) => {

      console.log("📤 [SEND MESSAGE]", {
        corsa_id,
        cliente_id,
        text
      });

      try {
        if (!text?.trim()) return;

        const sender_id = Number(socket.user.id);

        const canAccess = await pool.query(
          `SELECT 1
           FROM prenotazioni p
           INNER JOIN corse c ON c.id = p.corsa_id
           LEFT JOIN veicolo v ON v.id = c.veicolo_id
           WHERE p.corsa_id = $1
             AND p.cliente_id = $2
             AND (p.cliente_id = $3 OR v.driver_id = $3)`,
          [corsa_id, cliente_id, sender_id]
        );

        if (!canAccess.rows.length) {
          console.log("⛔ [SEND DENIED]");
          return;
        }

        const { rows } = await pool.query(
          `INSERT INTO messaggi
           (corsa_id, cliente_id, sender_id, testo, read_status)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id, created_at`,
          [
            corsa_id,
            cliente_id,
            sender_id,
            text.trim(),
            JSON.stringify({ autista: false, cliente: false }),
          ]
        );

        const msg = {
          ...rows[0],
          corsa_id,
          cliente_id,
          sender_id,
          text: text.trim(),
        };

        const room = `chat_${corsa_id}_${cliente_id}`;

        console.log("📡 [EMIT]", room, msg.id);

        io.to(room).emit('new_message', msg);

      } catch (err) {
        console.error("❌ [SEND ERROR]", err);
      }
    });
  });
};

export default chatRouter;