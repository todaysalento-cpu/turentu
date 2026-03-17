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
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

// =======================
// Endpoint: tutte le corse dell’utente con messaggi
// =======================
chatRouter.get('/init', authMiddleware, async (req, res) => {
  const { id: userId, role } = req.user;
  const roleLower = role.toLowerCase(); // autista | cliente

  console.log('🔹 Chat init chiamata da user:', userId, 'role:', roleLower);

  try {
    // Trova tutte le corse dell'utente
    const { rows: corse } = await pool.query(
      `SELECT DISTINCT c.id, c.origine_address, c.destinazione_address,
               v.driver_id, p.cliente_id
       FROM corse c
       LEFT JOIN veicolo v ON v.id = c.veicolo_id
       LEFT JOIN prenotazioni p ON p.corsa_id = c.id
       WHERE ($1::text = 'autista' AND v.driver_id = $2)
          OR ($1::text = 'cliente' AND p.cliente_id = $2)`,
      [roleLower, userId]
    );

    console.log('🔹 Corse trovate:', corse.length);
    console.log('🔹 Corse dettagli:', corse);

    // Costruisci threads
    const threads = await Promise.all(corse.map(async c => {
      const { rows: messaggi } = await pool.query(
        `SELECT id, corsa_id, sender_id, testo AS text, created_at AS timestamp, read_status
         FROM messaggi
         WHERE corsa_id=$1
         ORDER BY created_at ASC`,
        [c.id]
      );

      console.log(`🔹 Messaggi per corsa ${c.id}:`, messaggi.length);

      return {
        id: c.id,
        origine: c.origine_address || 'Origine sconosciuta',
        destinazione: c.destinazione_address || 'Destinazione sconosciuta',
        participants: [],
        messages: messaggi.map(m => ({
          ...m,
          sender_name: m.sender_id === userId ? roleLower : (roleLower === 'autista' ? 'cliente' : 'autista'),
          role: m.sender_id === userId ? roleLower : (roleLower === 'autista' ? 'cliente' : 'autista'),
          read_status: m.read_status || { autista: false, cliente: false }
        })),
        unreadCount: messaggi.filter(m => !m.read_status?.[roleLower]).length,
        lastMessageTime: messaggi[messaggi.length - 1]?.timestamp,
      };
    }));

    console.log('🔹 Threads costruiti:', threads.length);

    res.json(threads);

  } catch (err) {
    console.error('❌ Errore caricamento chat:', err);
    res.status(500).json({ message: 'Errore caricamento chat' });
  }
});

// =======================
// Endpoint: singola corsa con messaggi
// =======================
chatRouter.get('/init/:corsaId', authMiddleware, async (req, res) => {
  const { id: userId, role } = req.user;
  const roleLower = role.toLowerCase();
  const corsaId = parseInt(req.params.corsaId, 10);

  try {
    // Recupera messaggi della corsa
    const { rows: messaggi } = await pool.query(
      `SELECT id, corsa_id, sender_id, testo AS text, created_at AS timestamp, read_status
       FROM messaggi
       WHERE corsa_id=$1
       ORDER BY created_at ASC`,
      [corsaId]
    );

    // Recupera origine e destinazione
    const { rows: corsaRow } = await pool.query(
      `SELECT origine_address, destinazione_address
       FROM corse
       WHERE id=$1`,
      [corsaId]
    );
    const corsaInfo = corsaRow[0] || {};

    // Costruisci thread singolo
    const thread = {
      id: corsaId,
      origine: corsaInfo.origine_address || 'Origine sconosciuta',
      destinazione: corsaInfo.destinazione_address || 'Destinazione sconosciuta',
      participants: [],
      messages: messaggi.map(m => ({
        ...m,
        sender_name: m.sender_id === userId ? roleLower : (roleLower === 'autista' ? 'cliente' : 'autista'),
        role: m.sender_id === userId ? roleLower : (roleLower === 'autista' ? 'cliente' : 'autista'),
        read_status: m.read_status || { autista: false, cliente: false }
      })),
      unreadCount: messaggi.filter(m => !m.read_status?.[roleLower]).length,
      lastMessageTime: messaggi[messaggi.length - 1]?.timestamp,
    };

    res.json({ thread, messages: thread.messages });

  } catch (err) {
    console.error('Errore fetch messaggi:', err);
    res.status(500).json({ message: 'Errore fetch messaggi' });
  }
});

export default chatRouter;