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
  if (!token) return next(new Error('Authentication error: No token'));

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch {
    return next(new Error('Authentication error: Invalid token'));
  }
});

// ================= SOCKET CONNECTION =================

io.on('connection', (socket) => {
  const { id: userId, role } = socket.user;
  const personalRoom = `${role}_${userId}`;
  socket.join(personalRoom);

  console.log('🟢 Client autenticato:', socket.id);

  // ================= CHAT =================

  socket.on('join_corsa_chat', (corsaId) => {
    const room = `corsa_${corsaId}`;
    socket.join(room);
    console.log(`🔵 Socket ${socket.id} unito alla chat ${room}`);
  });

  socket.on('send_message', async ({ corsa_id, text }) => {
    if (!text?.trim()) return;

    const userRole = socket.user.role === 'autista' ? 'Autista' : 'Cliente';
    const timestamp = new Date();

    // read_status JSON: mittente = true, destinatario = false
    const readStatus = JSON.stringify({
      autista: userRole === 'Autista',
      cliente: userRole === 'Cliente'
    });

    try {
      const [result] = await pool.query(
        `INSERT INTO chat (corsa_id, user, text, timestamp, read_status)
         VALUES (?, ?, ?, ?, ?)`,
        [corsa_id, userRole, text.trim(), timestamp, readStatus]
      );

      const message = {
        id: result.insertId,
        corsa_id,
        user: userRole,
        text: text.trim(),
        timestamp,
        read_status: JSON.parse(readStatus)
      };

      // Invia a tutti nella stanza della corsa
      io.to(`corsa_${corsa_id}`).emit('new_message', message);

      // Aggiorna badge non letti per gli altri
      const otherRole = userRole === 'Autista' ? 'cliente' : 'autista';
      const [rows] = await pool.query(
        `SELECT id FROM chat
         WHERE corsa_id = ? AND JSON_EXTRACT(read_status, ?) = false`,
        [corsa_id, `$.${otherRole}`]
      );
      io.to(`corsa_${corsa_id}`).emit('unread_count', { corsa_id, count: rows.length });

    } catch (err) {
      console.error('Errore chat send_message:', err.message);
    }
  });

  socket.on('disconnect', () => {
    console.log('🔴 Client disconnesso:', socket.id);
  });
});

// ======================= NOTIFICHE LIVE =======================

export const sendNotification = ({ userId, role, notification }) => {
  if (!notification || !userId || !role) return;
  const roomName = `${role}_${userId}`;
  io.to(roomName).emit('new_notification', notification);
};

// ======================= HEALTH CHECK =======================

app.get('/', (_, res) => {
  res.json({ status: 'OK', service: 'TURENTU API' });
});

// ======================= SEARCH =======================

app.post('/search', async (req, res) => {
  try {
    const form = req.body;
    if (!form.coordDest) form.coordDest = { lat: 0, lon: 0 };
    const { cercaSlotUltra } = await import('./services/search/search.service.js');
    const risultati = await cercaSlotUltra(form);
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