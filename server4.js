// ======================= server.js =======================
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import http from 'http';
import { Server } from 'socket.io';
import { pool } from './db/db.js';
import * as pendingService from './services/pending/pending.service.js';
import { loadCachesUltra } from './services/search/search.cache.js';
import jwt from 'jsonwebtoken';

// Routers
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
import { notificationsRouter } from './routes/notification.routes.js'; // ✅ AGGIUNTO

const app = express();
const PORT = process.env.PORT || 3001;

// --------------------------- MIDDLEWARE -----------------------
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use('/webhook-stripe', stripeWebhookRouter);

// --------------------------- ROUTER ---------------------------
app.use('/auth', authRouter);
app.use('/booking', bookingRouter);
app.use('/booking', bookingClienteRouter);
app.use('/disponibilita', disponibilitaRouter);
app.use('/veicolo', veicoloRouter);
app.use('/corse', corseRouter);
app.use('/pending', pendingRouter);
app.use('/tariffe', tariffeRouter);
app.use('/distanza', distanzaRouter);
app.use('/notifications', notificationsRouter); // ✅ ADESSO FUNZIONA

// --------------------------- SOCKET.IO ------------------------
const serverHttp = http.createServer(app);

export const io = new Server(serverHttp, {
  cors: {
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ------------------ JWT Middleware per Socket.io ----------------
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Non autenticato'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = payload; // salva id e role nello socket
    next();
  } catch (err) {
    next(new Error('Token non valido'));
  }
});

io.on('connection', async (socket) => {
  console.log('🟢 Nuovo client connesso:', socket.id, 'userId:', socket.user.id);

  const userId = socket.user.id;
  const role = socket.user.role;
  const roomName = `${role}_${userId}`;
  socket.join(roomName);
  console.log(`🔑 Socket ${socket.id} unito alla stanza ${roomName}`);

  // Invia notifiche non viste al join
  try {
    const res = await pool.query(
      `SELECT * FROM notifications WHERE user_id=$1 AND seen=false ORDER BY created_at DESC`,
      [userId]
    );
    res.rows.forEach((n) => socket.emit('new_notification', n));
  } catch (err) {
    console.error('❌ Fetch notifica on join error:', err);
  }

  socket.on('disconnect', () => {
    console.log('🔴 Client disconnesso:', socket.id);
  });
});

// --------------------------- HEALTH CHECK -------------------
app.get('/', (_, res) => 
  res.json({ status: 'OK', service: 'TURENTU API' })
);

// --------------------------- SEARCH --------------------------
app.post('/search', async (req, res) => {
  try {
    const form = req.body;
    if (!form.coordDest) form.coordDest = { lat: 0, lon: 0 };

    const { cercaSlotUltra } = await import('./services/search/search.service.js');
    const risultati = await cercaSlotUltra(form);

    res.json(risultati);
  } catch (err) {
    console.error('❌ Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------- CLEANUP PENDING -----------------
setInterval(async () => {
  try {
    await pendingService.cleanupExpiredPending();
    console.log('🧹 Pending scaduti rimossi');
  } catch (err) {
    console.error('❌ Cleanup pending error:', err);
  }
}, 60_000);

// --------------------------- FUNZIONE PER NOTIFICHE LIVE -----------------
export const sendNotification = ({ userId, role, notification }) => {
  if (role === 'autista') io.to(`autista_${userId}`).emit('new_notification', notification);
  if (role === 'cliente') io.to(`cliente_${userId}`).emit('new_notification', notification);
  if (role === 'admin') io.emit('new_notification', notification);
};

// --------------------------- START SERVER -------------------
(async () => {
  try {
    await loadCachesUltra();
    console.log('✅ Cache iniziale caricata');
  } catch (err) {
    console.error('❌ Cache init error:', err);
  }

  serverHttp.listen(PORT, () =>
    console.log(`🚀 Backend + Socket.io avviato su http://localhost:${PORT}`)
  );
})();