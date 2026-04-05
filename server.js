// ======================= server.js =======================
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
import documentiAutistaRouter from './routes/documentiAutista.routes.js';
import documentiVeicoloRouter from './routes/documentiVeicolo.routes.js';

import * as pendingService from './services/pending/pending.service.js';
import { loadCachesUltra } from './services/search/search.cache.js';

const app = express();

// ======================= CORS CONFIGURAZIONE =======================
const FRONTEND_PROD = [
  'https://turentumi.vercel.app',
  'https://turentu-dkq55slsk-turentu.vercel.app' // staging / preview
];
const FRONTEND_DEV = [
  'http://localhost:3000',
  'https://turentumi.vercel.app' // utile se test da Vercel in locale
];

const allowedOrigins = process.env.NODE_ENV === 'production' ? FRONTEND_PROD : FRONTEND_DEV;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // server-to-server, Postman, CURL
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn(`❌ CORS non consentito per origin: ${origin}`);
    return callback(new Error('CORS non consentito'));
  },
  credentials: true,
}));

// preflight per tutte le rotte
app.options('*', cors({ origin: allowedOrigins, credentials: true }));

// ======================= LOGGING =======================
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] 🔹 ${req.method} ${req.originalUrl}`);
  next();
});

// ======================= STRIPE WEBHOOK =======================
app.use('/webhook-stripe', express.raw({ type: 'application/json' }), stripeWebhookRouter);

// ======================= MIDDLEWARE =======================
app.use(cookieParser());
app.use(express.json());

// ======================= ROUTES =======================
app.use('/api/auth', authRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/booking', bookingRouter);
app.use('/api/booking', bookingClienteRouter);
app.use('/api/disponibilita', disponibilitaRouter);
app.use('/api/veicolo', veicoloRouter);
app.use('/api/corse', corseRouter);
app.use('/api/pending', pendingRouter);
app.use('/api/tariffe', tariffeRouter);
app.use('/api/distanza', distanzaRouter);
app.use('/api/admin', adminRouter);
app.use('/api/chat', chatRouter);
app.use('/api/search', searchRouter);
app.use('/api/autista/profilo', autistaProfiloRouter);
app.use('/api/autista', autistaStatusRouter);
app.use('/api/autista/documenti', documentiAutistaRouter);
app.use('/api/documenti', documentiVeicoloRouter); // documenti veicolo

// ======================= HEALTH CHECK =======================
app.get('/', (_, res) =>
  res.json({ status: 'OK', service: 'TURENTU API', timestamp: new Date().toISOString() })
);

// ======================= 404 HANDLER =======================
app.use((req, res) =>
  res.status(404).json({ error: 'Not Found', path: req.originalUrl })
);

// ======================= ERROR HANDLER =======================
app.use((err, req, res, next) => {
  console.error('💥 ERROR:', err.message);
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message
  });
});

// ======================= SERVER + SOCKET.IO =======================
const port = process.env.PORT || 3001;
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  }
});

setupSocket(io);

// ======================= INIT CACHE REDIS =======================
const initCaches = async () => {
  if (!redisClient) return console.warn('⚠️ Redis non configurato');
  try {
    if (!redisClient.isOpen) await redisClient.connect();
    console.log('🟢 Redis pronto');

    await loadCachesUltra();
    console.log('🗃️ Cache caricate');
  } catch (err) {
    console.error('Errore cache:', err.message);
  }
};

// ======================= CLEANUP PENDING =======================
const cleanupPending = async () => {
  try {
    const count = await pendingService.cleanupExpired();
    console.log(`🧹 Cleanup pending: ${count}`);
  } catch (err) {
    console.error('Errore cleanup:', err.message);
  }
};

// ======================= START SERVER =======================
server.listen(port, '0.0.0.0', async () => {
  console.log(`🚀 Server su porta ${port}`);
  console.log('🟢 Socket.IO attivo');

  await initCaches();
  await cleanupPending();
});

export { io, server };