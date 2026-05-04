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
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    if (!token) return res.status(401).json({ message: 'No token' });

    const decoded = jwt.verify(token, JWT_SECRET);
    decoded.role = decoded.role.toLowerCase();
    req.user = decoded;
    next();
  } catch (err) {
    console.error('❌ Errore auth:', err.message);
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// ======================= INIT CHAT =======================
chatRouter.get('/init', authMiddleware, async (req, res) => {
  const { id: userId, role } = req.user;

  try {
    // Qui la tua logica originale, ad esempio:
    const { rows } = await pool.query('SELECT * FROM corse LIMIT 10');
    res.json(rows);
  } catch (err) {
    console.error('❌ Errore init chat:', err);
    res.status(500).json({ message: 'Errore init chat' });
  }
});

// ======================= SOCKET ATTACH =======================
export const attachChatSocket = (io) => {
  io.on('connection', (socket) => {
    console.log('📡 Nuovo client connesso:', socket.id);

    socket.on('join_chat', ({ corsa_id, cliente_id }) => {
      const room = `chat_${corsa_id}_${cliente_id}`;
      socket.join(room);
      console.log(`🟢 Utente entrato nella room: ${room}`);
    });

    socket.on('send_message', async ({ corsa_id, cliente_id, text, sender_id, sender_role }) => {
      try {
        const { rows } = await pool.query(`
          INSERT INTO messaggi (corsa_id, cliente_id, sender_id, testo, read_status)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, created_at AS timestamp
        `, [corsa_id, cliente_id, sender_id, text, JSON.stringify({ autista: false, cliente: false })]);

        const msg = {
          ...rows[0],
          corsa_id,
          cliente_id,
          sender_id,
          text,
          sender_name: sender_role === 'autista' ? 'Autista' : 'Cliente',
          role: sender_role,
        };

        const room = `chat_${corsa_id}_${cliente_id}`;
        io.to(room).emit('new_message', msg);

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

        for (let t of tokens) {
          if (t.push_token) {
            try {
              await fetch('https://fcm.googleapis.com/fcm/send', {
                method: 'POST',
                headers: {
                  'Authorization': `key=${process.env.FCM_SERVER_KEY}`,
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
              console.warn('⚠️ Errore invio push a token:', t.push_token, pushErr.message);
            }
          }
        }

      } catch (err) {
        console.error('❌ Errore send_message:', err);
      }
    });
  });
};

// ======================= EXPORT DEFAULT =======================
export default chatRouter;