import express from 'express';
import { pool } from '../db/db.js';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';

const chatRouter = express.Router();

const JWT_SECRET =
  process.env.JWT_SECRET || 'segreto-di-test';

// ======================= AUTH =======================
const authMiddleware = (req, res, next) => {
  try {
    const token =
      req.headers.authorization?.split(' ')[1] ||
      req.cookies?.token;

    if (!token) {
      return res.status(401).json({ message: 'No token' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    decoded.role = decoded.role.toLowerCase();

    req.user = decoded;
    next();
  } catch (err) {
    console.error('❌ auth error:', err.message);
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// ======================= INIT CHAT =======================
chatRouter.get('/init', authMiddleware, async (req, res) => {
  const { id: userIdRaw, role } = req.user;
  const userId = Number(userIdRaw);

  const MESSAGE_LIMIT = 30;

  try {
    let rows = [];

    // ================= AUTISTA =================
    if (role === 'autista') {
      const result = await pool.query(
        `
        SELECT
          c.id AS corsa_id,
          p.cliente_id,
          c.origine_address,
          c.destinazione_address,
          c.start_datetime
        FROM corse c
        INNER JOIN veicolo v ON v.id = c.veicolo_id
        INNER JOIN prenotazioni p ON p.corsa_id = c.id
        WHERE v.driver_id = $1
        GROUP BY
          c.id,
          p.cliente_id,
          c.origine_address,
          c.destinazione_address,
          c.start_datetime
        ORDER BY c.start_datetime DESC
        `,
        [userId]
      );

      rows = result.rows;
    }

    // ================= CLIENTE =================
    else if (role === 'cliente') {
      const result = await pool.query(
        `
        SELECT
          c.id AS corsa_id,
          p.cliente_id,
          c.origine_address,
          c.destinazione_address,
          c.start_datetime
        FROM prenotazioni p
        INNER JOIN corse c ON c.id = p.corsa_id
        WHERE p.cliente_id = $1
        GROUP BY
          c.id,
          p.cliente_id,
          c.origine_address,
          c.destinazione_address,
          c.start_datetime
        ORDER BY c.start_datetime DESC
        `,
        [userId]
      );

      rows = result.rows;
    }

    // ================= THREADS =================
    const threads = await Promise.all(
      rows.map(async (r) => {
        const corsaId = Number(r.corsa_id);
        const clienteId = Number(r.cliente_id);

        const chatId = `${corsaId}_${clienteId}`;

        // unread
        const { rows: unread } = await pool.query(
          `
          SELECT COUNT(*)::int AS count
          FROM messaggi
          WHERE corsa_id = $1
            AND cliente_id = $2
            AND sender_id != $3
          `,
          [corsaId, clienteId, userId]
        );

        // ================= LAST MESSAGES =================
        const { rows: messages } = await pool.query(
          `
          SELECT
            id,
            corsa_id,
            cliente_id,
            sender_id,
            testo AS text,
            created_at
          FROM messaggi
          WHERE corsa_id = $1
            AND cliente_id = $2
          ORDER BY created_at DESC
          LIMIT $3
          `,
          [corsaId, clienteId, MESSAGE_LIMIT]
        );

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

    return res.json(threads);
  } catch (err) {
    console.error('❌ init chat error:', err);
    return res.status(500).json({ message: 'Errore init chat' });
  }
});

// ======================= PAGINATION (CURSOR BASED) =======================
chatRouter.get('/messages', authMiddleware, async (req, res) => {
  const {
    corsa_id,
    cliente_id,
    cursor, // created_at del più vecchio già caricato
    limit = 30,
  } = req.query;

  try {
    const values = [
      corsa_id,
      cliente_id,
      Number(limit),
    ];

    let cursorQuery = '';

    if (cursor) {
      values.push(cursor);
      cursorQuery = `AND created_at < $4`;
    }

    const { rows } = await pool.query(
      `
      SELECT
        id,
        corsa_id,
        cliente_id,
        sender_id,
        testo AS text,
        created_at
      FROM messaggi
      WHERE corsa_id = $1
        AND cliente_id = $2
        ${cursorQuery}
      ORDER BY created_at DESC
      LIMIT $3
      `,
      values
    );

    return res.json({
      messages: rows.reverse(),
      hasMore: rows.length === Number(limit),
      nextCursor: rows.length
        ? rows[rows.length - 1].created_at
        : null,
    });
  } catch (err) {
    console.error('❌ pagination error:', err);
    return res.status(500).json({ message: 'error' });
  }
});

// ======================= SOCKET =======================
export const attachChatSocket = (io) => {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('no token'));

      const decoded = jwt.verify(token, JWT_SECRET);
      decoded.role = decoded.role.toLowerCase();
      socket.user = decoded;

      next();
    } catch {
      next(new Error('invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log('📡 socket connected:', socket.id);

    socket.on('join_chat', async ({ corsa_id, cliente_id }) => {
      try {
        const userId = Number(socket.user.id);

        const access = await pool.query(
          `
          SELECT 1
          FROM prenotazioni p
          INNER JOIN corse c ON c.id = p.corsa_id
          LEFT JOIN veicolo v ON v.id = c.veicolo_id
          WHERE p.corsa_id = $1
            AND p.cliente_id = $2
            AND (
              p.cliente_id = $3
              OR v.driver_id = $3
            )
          `,
          [corsa_id, cliente_id, userId]
        );

        if (!access.rows.length) return;

        socket.join(`chat_${corsa_id}_${cliente_id}`);
      } catch (err) {
        console.error('join_chat error:', err);
      }
    });

    socket.on('send_message', async ({ corsa_id, cliente_id, text }) => {
      try {
        if (!text?.trim()) return;

        const sender_id = Number(socket.user.id);
        const sender_role = socket.user.role;

        const canAccess = await pool.query(
          `
          SELECT 1
          FROM prenotazioni p
          INNER JOIN corse c ON c.id = p.corsa_id
          LEFT JOIN veicolo v ON v.id = c.veicolo_id
          WHERE p.corsa_id = $1
            AND p.cliente_id = $2
            AND (
              p.cliente_id = $3
              OR v.driver_id = $3
            )
          `,
          [corsa_id, cliente_id, sender_id]
        );

        if (!canAccess.rows.length) return;

        const { rows } = await pool.query(
          `
          INSERT INTO messaggi
          (corsa_id, cliente_id, sender_id, testo, read_status)
          VALUES ($1,$2,$3,$4,$5)
          RETURNING id, created_at
          `,
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
          role: sender_role,
        };

        io.to(`chat_${corsa_id}_${cliente_id}`).emit(
          'new_message',
          msg
        );
      } catch (err) {
        console.error('send_message error:', err);
      }
    });
  });
};

export default chatRouter;