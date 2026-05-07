// routes/chat.routes.js
import express from 'express';
import { pool } from '../db/db.js';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';

const chatRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';

// ======================= AUTH MIDDLEWARE =======================
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
    console.error('❌ Errore auth:', err.message);
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// ======================= INIT CHAT (FIXED) =======================
chatRouter.get('/init', authMiddleware, async (req, res) => {
  const { id: userIdRaw, role } = req.user;
  const userId = parseInt(userIdRaw, 10);

  try {
    // 🔥 CHAT REALI BASATE SU MESSAGGI
    const { rows } = await pool.query(`
      SELECT DISTINCT
        m.corsa_id,
        m.cliente_id,
        c.origine_address AS origine,
        c.destinazione_address AS destinazione,
        c.start_datetime
      FROM messaggi m
      JOIN corse c ON c.id = m.corsa_id
      WHERE m.sender_id = $1 OR m.cliente_id = $1
      ORDER BY c.start_datetime DESC
    `, [userId]);

    const threads = await Promise.all(
      rows.map(async (row) => {
        const corsaId = parseInt(row.corsa_id, 10);
        const clienteId = parseInt(row.cliente_id, 10);

        // unread messages
        const { rows: unread } = await pool.query(`
          SELECT COUNT(*) AS count
          FROM messaggi
          WHERE corsa_id=$1
            AND cliente_id=$2
            AND sender_id != $3
            AND NOT (read_status->>$4)::boolean
        `, [corsaId, clienteId, userId, role]);

        // messages
        const { rows: messagesRows } = await pool.query(`
          SELECT 
            id,
            corsa_id,
            cliente_id,
            sender_id,
            testo AS text,
            created_at AS timestamp,
            read_status
          FROM messaggi
          WHERE corsa_id=$1 AND cliente_id=$2
          ORDER BY created_at ASC
        `, [corsaId, clienteId]);

        const messages = messagesRows.map(m => ({
          ...m,
          sender_name:
            m.sender_id === userId
              ? role
              : role === 'autista'
                ? 'cliente'
                : 'autista',
          role:
            m.sender_id === userId
              ? role
              : role === 'autista'
                ? 'cliente'
                : 'autista',
          read_status:
            typeof m.read_status === 'string'
              ? JSON.parse(m.read_status)
              : m.read_status || { autista: false, cliente: false }
        }));

        return {
          id: `${corsaId}_${clienteId}`,
          corsa_id: corsaId,
          cliente_id: clienteId,
          origine: row.origine,
          destinazione: row.destinazione,
          start_datetime: row.start_datetime,
          unreadCount: parseInt(unread[0]?.count || 0, 10),
          messages,
          participants: []
        };
      })
    );

    res.json(threads);
  } catch (err) {
    console.error('❌ Errore init chat:', err);
    res.status(500).json({ message: 'Errore init chat' });
  }
});

// ======================= SOCKET =======================
export const attachChatSocket = (io) => {
  io.on('connection', (socket) => {
    console.log('📡 Nuovo client connesso:', socket.id);

    socket.on('join_chat', ({ corsa_id, cliente_id }) => {
      const room = `chat_${corsa_id}_${cliente_id}`;
      socket.join(room);
    });

    socket.on('send_message', async ({ corsa_id, cliente_id, text }) => {
      try {
        const sender_id = socket.user?.id;
        const sender_role = socket.user?.role;

        const { rows } = await pool.query(`
          INSERT INTO messaggi (corsa_id, cliente_id, sender_id, testo, read_status)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, created_at AS timestamp
        `, [
          corsa_id,
          cliente_id,
          sender_id,
          text,
          JSON.stringify({ autista: false, cliente: false })
        ]);

        const msg = {
          ...rows[0],
          corsa_id,
          cliente_id,
          sender_id,
          text,
          sender_name: sender_role === 'autista' ? 'Autista' : 'Cliente',
          role: sender_role
        };

        io.to(`chat_${corsa_id}_${cliente_id}`).emit('new_message', msg);

        // ================= PUSH =================
        const { rows: tokens } = await pool.query(`
          SELECT push_token
          FROM utente_push_tokens
          WHERE user_id != $1
            AND user_id IN (
              SELECT cliente_id FROM prenotazioni WHERE corsa_id=$2
              UNION
              SELECT driver_id FROM veicolo v
              JOIN corse c ON v.id = c.veicolo_id
              WHERE c.id=$2
            )
        `, [sender_id, corsa_id]);

        for (const t of tokens) {
          if (!t.push_token) continue;

          try {
            await fetch('https://fcm.googleapis.com/fcm/send', {
              method: 'POST',
              headers: {
                Authorization: `key=${process.env.FCM_SERVER_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                to: t.push_token,
                notification: {
                  title: 'Nuovo messaggio',
                  body: text,
                  sound: 'default',
                },
                data: { corsa_id, cliente_id, message_id: msg.id },
              }),
            });
          } catch (pushErr) {
            console.warn('⚠️ Push error:', pushErr.message);
          }
        }
      } catch (err) {
        console.error('❌ Errore send_message:', err);
      }
    });
  });
};

export default chatRouter;