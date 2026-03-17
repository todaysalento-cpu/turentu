// routes/chat.routes.js
import express from 'express';
import { pool } from '../db/db.js';
import jwt from 'jsonwebtoken';

export const chatRouter = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';

// =======================
// Middleware di autenticazione
// =======================
const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token' });

    const decoded = jwt.verify(token, JWT_SECRET);
    decoded.role = decoded.role.toLowerCase();
    req.user = decoded;

    console.log('✅ Utente autenticato:', decoded);
    next();
  } catch (err) {
    console.error('❌ Errore auth:', err.message);
    res.status(401).json({ message: 'Invalid token' });
  }
};

// =======================
// INIT THREADS CON MESSAGGI
// =======================
chatRouter.get('/init', authMiddleware, async (req, res) => {
  let { id: userId, role } = req.user;
  userId = parseInt(userId, 10);

  try {
    let rows;

    if (role === 'autista') {
      const result = await pool.query(`
        SELECT 
          c.id AS corsa_id,
          p.cliente_id,
          c.origine_address AS origine,
          c.destinazione_address AS destinazione,
          c.start_datetime
        FROM corse c
        JOIN veicolo v ON v.id = c.veicolo_id
        JOIN prenotazioni p ON p.corsa_id = c.id
        WHERE v.driver_id = $1
        ORDER BY c.start_datetime DESC
      `, [userId]);
      rows = result.rows;
    } else {
      const result = await pool.query(`
        SELECT 
          c.id AS corsa_id,
          p.cliente_id,
          c.origine_address AS origine,
          c.destinazione_address AS destinazione,
          c.start_datetime
        FROM corse c
        JOIN prenotazioni p ON p.corsa_id = c.id
        WHERE p.cliente_id = $1
        ORDER BY c.start_datetime DESC
      `, [userId]);
      rows = result.rows;
    }

    const threads = await Promise.all(
      rows.map(async (row) => {
        const corsaId = parseInt(row.corsa_id, 10);
        const clienteId = parseInt(row.cliente_id, 10);

        // unread count
        const { rows: unread } = await pool.query(`
          SELECT COUNT(*) AS count
          FROM messaggi
          WHERE corsa_id=$1
            AND cliente_id=$2
            AND sender_id != $3
            AND NOT (read_status->>$4)::boolean
        `, [corsaId, clienteId, userId, role]);

        // messaggi reali
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
          sender_name: m.sender_id === userId ? role : role === 'autista' ? 'cliente' : 'autista',
          role: m.sender_id === userId ? role : role === 'autista' ? 'cliente' : 'autista',
          read_status: typeof m.read_status === 'string' ? JSON.parse(m.read_status) : m.read_status || { autista: false, cliente: false }
        }));

        return {
          id: `${corsaId}_${clienteId}`,
          corsa_id: corsaId,
          cliente_id: clienteId,
          origine: row.origine,
          destinazione: row.destinazione,
          start_datetime: row.start_datetime,
          unreadCount: parseInt(unread[0].count, 10) || 0,
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

// =======================
// CLIENTI DI UNA CORSA
// =======================
chatRouter.get('/:corsaId/clients', authMiddleware, async (req, res) => {
  const corsaId = parseInt(req.params.corsaId, 10);

  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.nome
      FROM utente u
      JOIN prenotazioni p ON p.cliente_id = u.id
      WHERE p.corsa_id = $1
    `, [corsaId]);

    res.json(rows);
  } catch (err) {
    console.error('❌ Errore fetch clienti:', err);
    res.status(500).json({ message: 'Errore fetch clienti' });
  }
});

// =======================
// FETCH MESSAGGI DI UNA CHAT
// =======================
chatRouter.get('/:corsaId/:clienteId', authMiddleware, async (req, res) => {
  const { id: userIdRaw, role } = req.user;
  const userId = parseInt(userIdRaw, 10);
  const corsaId = parseInt(req.params.corsaId, 10);
  const clienteId = parseInt(req.params.clienteId, 10);

  try {
    const { rows } = await pool.query(`
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

    const messages = rows.map(m => ({
      ...m,
      sender_name: m.sender_id === userId ? role : role === 'autista' ? 'cliente' : 'autista',
      role: m.sender_id === userId ? role : role === 'autista' ? 'cliente' : 'autista',
      read_status: typeof m.read_status === 'string' ? JSON.parse(m.read_status) : m.read_status || { autista: false, cliente: false }
    }));

    res.json({
      id: `${corsaId}_${clienteId}`,
      corsa_id: corsaId,
      cliente_id: clienteId,
      messages
    });
  } catch (err) {
    console.error('❌ Errore fetch messaggi:', err);
    res.status(500).json({ message: 'Errore fetch messaggi' });
  }
});

// =======================
// SOCKET: SEND MESSAGE
// =======================
export const attachChatSocket = (io) => {
  io.on('connection', (socket) => {
    console.log('📡 Nuovo client connesso:', socket.id);

    socket.on('join_chat', ({ corsa_id, cliente_id }) => {
      const room = `chat_${corsa_id}_${cliente_id}`;
      socket.join(room);
      console.log(`🟢 Utente entrato nella room: ${room}`);
    });

    socket.on('send_message', async ({ corsa_id, cliente_id, text, sender_id }) => {
      try {
        // inserimento nel DB
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
          sender_name: 'autista', // da calcolare in base al sender_id e ruolo reale
          role: 'autista'
        };

        const room = `chat_${corsa_id}_${cliente_id}`;
        io.to(room).emit('new_message', msg); // ✅ solo messaggio nuovo
      } catch (err) {
        console.error('❌ Errore send_message:', err);
      }
    });
  });
};

export default chatRouter;