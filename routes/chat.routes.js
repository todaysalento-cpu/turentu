import express from 'express';
import { pool } from '../db/db.js';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';

const chatRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';

// ======================= AUTH =======================
const authMiddleware = (req, res, next) => {
  try {
    const token =
      req.headers.authorization?.split(' ')[1] ||
      req.cookies?.token;

    if (!token) return res.status(401).json({ message: 'No token' });

    const decoded = jwt.verify(token, JWT_SECRET);
    decoded.role = decoded.role.toLowerCase();
    req.user = decoded;

    next();
  } catch (err) {
    console.error('❌ auth error:', err.message);
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// ======================= INIT CHAT (FIXED) =======================
chatRouter.get('/init', authMiddleware, async (req, res) => {
  const { id: userIdRaw, role } = req.user;
  const userId = parseInt(userIdRaw, 10);

  try {

    let rows = [];

    // ===================== AUTISTA =====================
    if (role === 'autista') {
      const result = await pool.query(`
        SELECT 
          c.id AS corsa_id,
          p.cliente_id,
          c.origine_address,
          c.destinazione_address,
          c.start_datetime
        FROM corse c
        JOIN veicolo v ON v.id = c.veicolo_id
        JOIN prenotazioni p ON p.corsa_id = c.id
        WHERE v.driver_id = $1
        ORDER BY c.start_datetime DESC
      `, [userId]);

      rows = result.rows;
    }

    // ===================== CLIENTE =====================
    else {
      const result = await pool.query(`
        SELECT 
          c.id AS corsa_id,
          p.cliente_id,
          c.origine_address,
          c.destinazione_address,
          c.start_datetime
        FROM prenotazioni p
        JOIN corse c ON c.id = p.corsa_id
        WHERE p.cliente_id = $1
        ORDER BY c.start_datetime DESC
      `, [userId]);

      rows = result.rows;
    }

    // ===================== THREADS =====================
    const threads = await Promise.all(
      rows.map(async (r) => {
        const corsaId = r.corsa_id;
        const clienteId = r.cliente_id;

        // unread
        const { rows: unread } = await pool.query(`
          SELECT COUNT(*)::int AS count
          FROM messaggi
          WHERE corsa_id=$1
            AND cliente_id=$2
            AND sender_id != $3
            AND COALESCE((read_status->>$4)::boolean, false) = false
        `, [corsaId, clienteId, userId, role]);

        // messages
        const { rows: messages } = await pool.query(`
          SELECT 
            id,
            corsa_id,
            cliente_id,
            sender_id,
            testo AS text,
            created_at,
            read_status
          FROM messaggi
          WHERE corsa_id=$1 AND cliente_id=$2
          ORDER BY created_at ASC
        `, [corsaId, clienteId]);

        return {
          id: `${corsaId}_${clienteId}`,
          corsa_id: corsaId,
          cliente_id: clienteId,
          origine: r.origine_address,
          destinazione: r.destinazione_address,
          start_datetime: r.start_datetime,
          unreadCount: unread?.[0]?.count || 0,
          messages
        };
      })
    );

    res.json(threads);

  } catch (err) {
    console.error('❌ init chat error:', err);
    res.status(500).json({ message: 'Errore init chat' });
  }
});

// ======================= SOCKET =======================
export const attachChatSocket = (io) => {
  io.on('connection', (socket) => {
    console.log('📡 socket connected:', socket.id);

    socket.on('join_chat', ({ corsa_id, cliente_id }) => {
      socket.join(`chat_${corsa_id}_${cliente_id}`);
    });

    socket.on('send_message', async ({ corsa_id, cliente_id, text }) => {
      try {

        const sender_id = socket.user?.id;
        const sender_role = socket.user?.role;

        const { rows } = await pool.query(`
          INSERT INTO messaggi
          (corsa_id, cliente_id, sender_id, testo, read_status)
          VALUES ($1,$2,$3,$4,$5)
          RETURNING id, created_at
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
                },
                data: { corsa_id, cliente_id, message_id: msg.id },
              }),
            });
          } catch (e) {
            console.warn('push error:', e.message);
          }
        }

      } catch (err) {
        console.error('❌ send_message error:', err);
      }
    });
  });
};

export default chatRouter;