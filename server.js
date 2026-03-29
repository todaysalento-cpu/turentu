// ======================= server.js (CORS + cookie fix Safari + logging) =======================
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import http from 'http';
import { Server } from 'socket.io';

import { setupSocket } from './socket.js';
import { redisClient } from './redis.js';

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
import autistaProfiloRouter from './routes/autistaProfilo.routes.js';
import autistaStatusRouter from './routes/autistaStatus.routes.js';
import * as pendingService from './services/pending/pending.service.js';
import { loadCachesUltra } from './services/search/search.cache.js';

const app = express();

// ======================= ALLOWED ORIGINS
const allowedOrigins = [
  'http://localhost:3000',                           // dev
  'https://turentu-6zju0bt3n-turentu.vercel.app',    // prod attuale
  'https://turentu-7wmvl71px-turentu.vercel.app',    // vecchio prod
  'https://turentumi.vercel.app',                    // nuovo prod
];

// ======================= CORS CONFIG
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn('CORS non consentito:', origin);
      callback(new Error('CORS non consentito'));
    }
  },
  credentials: true, // fondamentale per cookie cross-site
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ======================= LOGGING MIDDLEWARE
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] 🔹 REQUEST: ${req.method} ${req.originalUrl} - From: ${req.ip}`);
  next();
});

app.use((req, res, next) => {
  const originalSend = res.send;
  res.send = function (body) {
    console.log(`[${new Date().toISOString()}] 🔹 RESPONSE ${res.statusCode} for ${req.method} ${req.originalUrl}`);
    return originalSend.call(this, body);
  };
  next();
});

app.use('/autista', (req, res, next) => {
  console.log(`[${new Date().toISOString()}] 🏎️ Autista route hit: ${req.method} ${req.originalUrl}`);
  next();
});

// ======================= STRIPE WEBHOOK
app.use('/webhook-stripe', express.raw({ type: 'application/json' }), stripeWebhookRouter);

// ======================= MIDDLEWARE STANDARD
app.use(cookieParser());
app.use(express.json());

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
app.use('/autista/profilo', autistaProfiloRouter);
app.use('/autista', autistaStatusRouter);

// ======================= HEALTH CHECK
app.get('/', (_, res) =>
  res.json({ status: 'OK', service: 'TURENTU API', timestamp: new Date().toISOString() })
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
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production'
      ? 'Something went wrong'
      : err.message
  });
});

// ======================= SERVER HTTP + SOCKET.IO
const port = process.env.PORT || 3000;
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET','POST','PUT','DELETE','OPTIONS'],
    credentials: true
  }
});

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