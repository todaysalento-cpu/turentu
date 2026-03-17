// ======================= server.js =======================
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import http from 'http';

import { pool } from './db/db.js';
import * as pendingService from './services/pending/pending.service.js';
import { loadCachesUltra } from './services/search/search.cache.js';

// ROUTERS
import adminRouter from './routes/admin/index.js';
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
import { chatRouter } from './routes/chat.routes.js'; // ✅ chat router

// SOCKET.IO
import { Server } from 'socket.io';
import { setupSocket } from './socket.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ===== MIDDLEWARE =====
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(cookieParser());
app.use('/webhook-stripe', stripeWebhookRouter);
app.use(express.json());

// ===== LOG REQUEST =====
app.use((req, res, next) => {
  console.log(`🌐 ${req.method} ${req.url} | Body:`, req.body, '| Query:', req.query);
  next();
});

// ===== ROUTES =====
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
app.use('/admin', adminRouter);
app.use('/chat', chatRouter); // ✅ chat router montato

// ===== SERVER HTTP & SOCKET.IO =====
const serverHttp = http.createServer(app);

export const io = new Server(serverHttp, {
  cors: { origin: 'http://localhost:3000', methods: ['GET','POST'], credentials: true }
});

// ===== Setup Socket.IO =====
setupSocket(io);

// ===== HEALTH CHECK =====
app.get('/', (_, res) => {
  console.log('✅ Health check chiamato');
  res.json({ status: 'OK', service: 'TURENTU API' });
});

// ===== SEARCH =====
app.post('/search', async (req, res) => {
  try {
    const form = req.body;
    if (!form.coordDest) form.coordDest = { lat: 0, lon: 0 };
    const { cercaSlotUltra } = await import('./services/search/search.service.js');
    const risultati = await cercaSlotUltra(form);
    console.log('🔍 Search risultati:', risultati.length);
    res.json(risultati);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== CLEANUP PENDING =====
const cleanupPending = async () => {
  try {
    const count = await pendingService.cleanupExpired();
    console.log(`🧹 Pending cleanup completato, ${count} elementi rimossi`);
  } catch (err) {
    console.error('Errore cleanup pending:', err.message);
  }
};

// ===== LOAD CACHES =====
const initCaches = async () => {
  try {
    await loadCachesUltra();
    console.log('🗃️ Caches search caricate');
  } catch (err) {
    console.error('Errore load caches:', err.message);
  }
};

// ===== START SERVER =====
serverHttp.listen(PORT, async () => {
  console.log(`🚀 Server avviato su http://localhost:${PORT}`);
  await initCaches();
  await cleanupPending();
});