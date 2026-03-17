// ======================= server.js =======================

import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import http from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';

import { pool } from './db/db.js';
import * as pendingService from './services/pending/pending.service.js';
import { loadCachesUltra } from './services/search/search.cache.js';

// ======================= ROUTERS =======================

// Admin
import adminRouter from './routes/admin/index.js';

// Altri routers
import bookingRouter from './routes/booking.routes.js';
import { bookingClienteRouter } from './routes/booking.cliente.routes.js';
import { router as stripeWebhookRouter } from './routes/stripe-webhook.js';
import { router as authRouter } from './routes/auth.routes.js';
import { disponibilitaRouter } from './routes/disponibilita.routes.js';
import { veicoloRouter } from './routes/veicolo.routes.js';
import { corseRouter } from './routes/corse.routes.js';
import { pendingRouter } from './routes/pending.routes.js';
import { tariffeRouter } from './routes/tariffe.routes.js';
import distanzaRouter from './routes/distanza.route.js';
import { notificationsRouter } from './routes/notification.routes.js';
import { chatRouter } from './routes/chat.routes.js';

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';

// =========================== MIDDLEWARE ===========================

app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));
app.use(cookieParser());

// Webhook Stripe PRIMA di express.json()
app.use('/webhook-stripe', stripeWebhookRouter);

// Parser JSON
app.use(express.json());

// =========================== ROUTES ===============================

app.use('/auth', authRouter);
app.use('/notifications', notificationsRouter);

app.use('/booking', bookingRouter);
app.use('/booking', bookingClienteRouter);
app.use('/disponibilita', disponibilitaRouter);
app.use('/veicolo', veicoloRouter);
app.use('/corse', corseRouter);
app.use('/pending', pendingRouter);
app.use('/tariffe', tariffeRouter);
app.use('/distanza', distanzaRouter);
app.use('/chat', chatRouter);

app.use('/admin', adminRouter);

// =========================== SOCKET.IO ============================

const serverHttp = http.createServer(app);

export const io = new Server(serverHttp, {
  cors: {
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ================= SOCKET AUTH =================

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  console.log('🔑 Socket auth attempt, token:', token?.slice(0,10)+'...');

  if (!token) return next(new Error('Authentication error: No token'));

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    console.log('✅ Token valido, user:', decoded);
    next();
  } catch (err) {
    console.error('❌ Token invalido', err.message);
    return next(new Error('Authentication error: Invalid token'));
  }
});

// ================= SOCKET CONNECTION =================

io.on('connection', (socket) => {
  console.log('==========================');
  console.log('🟢 Nuovo client connesso');
  console.log('Socket ID:', socket.id);
  console.log('Handshake:', socket.handshake);
  console.log('==========================');

  const { id: userId, role } = socket.user;
  const personalRoom = `${role}_${userId}`;

  socket.join(personalRoom);
  console.log(`🔹 Socket unito alla room personale: ${personalRoom}`);

  // ================= CHAT =================
  socket.on('join_corsa_chat', (corsaId) => {
    const room = `corsa_${corsaId}`;
    socket.join(room);
    console.log(`🔵 join_corsa_chat: socket ${socket.id} unito alla room ${room}`);
  });

  socket.on('leave_corsa_chat', (corsaId) => {
    const room = `corsa_${corsaId}`;
    socket.leave(room);
    console.log(`🔴 leave_corsa_chat: socket ${socket.id} uscito dalla room ${room}`);
  });

  socket.on('send_message', async ({ corsa_id, text }) => {
    console.log('📩 send_message ricevuto:', { corsa_id, text, socketUser: socket.user });

    if (!text?.trim()) return console.log('⚠️ Messaggio vuoto, niente da salvare');

    try {
      const result = await pool.query(
        `INSERT INTO messaggi (corsa_id, sender_id, testo)
         VALUES ($1,$2,$3)
         RETURNING id, corsa_id, sender_id, testo, created_at`,
        [corsa_id, userId, text.trim()]
      );

      const dbMsg = result.rows[0];
      const message = {
        id: dbMsg.id,
        corsa_id: dbMsg.corsa_id,
        sender_id: dbMsg.sender_id,
        user: role,
        text: dbMsg.testo,
        timestamp: dbMsg.created_at
      };

      console.log('✅ Messaggio salvato nel DB:', message);

      io.to(`corsa_${corsa_id}`).emit('new_message', message);
      console.log(`🔵 Messaggio emesso a corsa_${corsa_id}`);

      const unreadRes = await pool.query(
        `SELECT COUNT(*) AS unread
         FROM messaggi
         WHERE corsa_id = $1
         AND sender_id != $2`,
        [corsa_id, userId]
      );

      const unreadCount = parseInt(unreadRes.rows[0].unread, 10);

      io.to(`corsa_${corsa_id}`).emit('unread_count', { corsa_id, count: unreadCount });
      console.log(`📊 Unread count aggiornato per corsa_${corsa_id}: ${unreadCount}`);

    } catch (err) {
      console.error('❌ Errore chat send_message:', err);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('🔴 Client disconnesso:', socket.id, '| reason:', reason);
  });
});

// ======================= NOTIFICHE LIVE =======================

export const sendNotification = ({ userId, role, notification }) => {
  if (!notification || !userId || !role) return;
  const roomName = `${role}_${userId}`;
  console.log(`🔔 Invio notifica a ${roomName}:`, notification);
  io.to(roomName).emit('new_notification', notification);
};

// ======================= HEALTH CHECK =======================

app.get('/', (_, res) => {
  console.log('📡 Health check ricevuto');
  res.json({ status: 'OK', service: 'TURENTU API' });
});

// ======================= SEARCH =======================

app.post('/search', async (req, res) => {
  try {
    const form = req.body;
    if (!form.coordDest) form.coordDest = { lat: 0, lon: 0 };
    console.log('🔍 Search request:', form);
    const { cercaSlotUltra } = await import('./services/search/search.service.js');
    const risultati = await cercaSlotUltra(form);
    console.log('🔍 Search results:', risultati.length || 0);
    res.json(risultati);
  } catch (err) {
    console.error('❌ Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ======================= CLEANUP PENDING =======================

setInterval(async () => {
  try {
    await pendingService.cleanupExpiredPending();
    console.log('🧹 Pending scaduti rimossi');
  } catch (err) {
    console.error('❌ Cleanup pending error:', err.message);
  }
}, 60000);

// ======================= START SERVER =======================

(async () => {
  try {
    await loadCachesUltra();
    console.log('✅ Cache iniziale caricata');
  } catch (err) {
    console.error('❌ Cache init error:', err.message);
  }

  serverHttp.listen(PORT, () => {
    console.log(`🚀 Backend + Socket.io avviato su http://localhost:${PORT}`);
  });
})();