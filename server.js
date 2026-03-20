// ======================= server.js (HTTP + Socket.IO + Redis) =======================
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import http from 'http';
import { Server } from 'socket.io';

// ===== SOCKET SETUP =====
import { setupSocket } from './socket.js';

// ===== REDIS =====
import { redisClient } from './redis.js';

// ===== ROUTERS =====
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
import { chatRouter } from './routes/chat.routes.js';
import searchRouter from './routes/search.routes.js';

// ===== SERVICES =====
import * as pendingService from './services/pending/pending.service.js';
import { loadCachesUltra } from './services/search/search.cache.js';

const app = express();

// ======================= CORS (FIX DEFINITIVO) =======================
app.use(cors({
  origin: true, // 🔥 accetta qualsiasi origin (Vercel friendly)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 🔥 fondamentale per preflight
app.options('*', cors({
  origin: true,
  credentials: true
}));

// ======================= STRIPE WEBHOOK (RAW BODY)
app.use('/webhook-stripe', express.raw({ type: 'application/json' }), stripeWebhookRouter);

// ======================= MIDDLEWARE STANDARD
app.use(cookieParser());
app.use(express.json());

// ======================= LOGGING DEV
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`🌐 ${req.method} ${req.url}`);
    if (Object.keys(req.body || {}).length) console.log('📦 Body:', req.body);
    if (Object.keys(req.query || {}).length) console.log('🔎 Query:', req.query);
    next();
  });
}

// ======================= ROUTES
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
app.use('/chat', chatRouter);
app.use('/search', searchRouter);

// ======================= HEALTH CHECK
app.get('/', (_, res) =>
  res.json({
    status: 'OK',
    service: 'TURENTU API',
    timestamp: new Date().toISOString()
  })
);

app.get('/ping', (_, res) =>
  res.json({ status: 'pong', message: 'API server funzionante!' })
);

// ======================= 404
app.use((req, res) =>
  res.status(404).json({ error: 'Not Found', path: req.originalUrl })
);

// ======================= GLOBAL ERROR HANDLER
app.use((err, req, res, next) => {
  console.error('💥 ERROR:', err.message);
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message:
      process.env.NODE_ENV === 'production'
        ? 'Something went wrong'
        : err.message
  });
});

// ======================= SERVER HTTP + SOCKET.IO
const port = process.env.PORT || 3000;
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true, // 🔥 stesso fix anche qui
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  }
});

// setup Socket.IO
setupSocket(io);

// ======================= INIT CACHES REDIS
const initCaches = async () => {
  if (!redisClient) return console.warn('⚠️ Redis non configurato');

  try {
    if (!redisClient.isOpen) await redisClient.connect();
    console.log('🟢 Redis pronto');

    await loadCachesUltra();
    console.log('🗃️ Caches search caricate in Redis');
  } catch (err) {
    console.error('Errore init caches:', err.message);
  }
};

// ======================= CLEANUP PENDING
const cleanupPending = async () => {
  try {
    const count = await pendingService.cleanupExpired();
    console.log(`🧹 Pending cleanup completato, ${count} elementi rimossi`);
  } catch (err) {
    console.error('Errore cleanup pending:', err.message);
  }
};

// ======================= START SERVER
server.listen(port, '0.0.0.0', async () => {
  console.log(`🚀 Server avviato su port ${port}`);
  console.log('🟢 Socket.IO pronto');

  await initCaches();
  await cleanupPending();
});

export { io, server };