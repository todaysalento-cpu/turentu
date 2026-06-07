// --- DEBUG FATALE: Intercetta crash all'avvio su Render ---
process.on('uncaughtException', (err) => {
  console.error('--- CRASH FATALE (uncaughtException) ---');
  console.error(err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('--- REJECTION NON GESTITA (unhandledRejection) ---');
  console.error('Reason:', reason);
  console.error('Promise:', promise);
  process.exit(1);
});

import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import http from 'http';
import { Server } from 'socket.io';
import { createAdapter } from "@socket.io/redis-adapter";

// ======================= SOCKET + REDIS =======================
import { setupSocket } from './socket.js';
import { redisClient } from './redis.js';

// ======================= FLOW REGISTRY =======================
import { flowRegistry } from './core/registry/flowRegistry.js';
import { onboardingFlow } from './core/registry/flows/onboarding.flow.js';

// ======================= ROUTES =======================
import flowsRouter from './routes/flows.routes.js';
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
import chatRouter from './routes/chat.routes.js';
import searchRouter from './routes/search.routes.js';
import autistaProfiloRouter from './routes/autistaProfilo.routes.js';
import autistaStatusRouter from './routes/autistaStatus.routes.js';
import documentiAutistaRouter from './routes/documentiAutista.routes.js';
import documentiVeicoloRouter from './routes/documentiVeicolo.routes.js';
import prenotazioniRouter from './routes/prenotazioni.routes.js';
import pagamentiAutistaRouter from './routes/pagamenti.autista.routes.js';

// ======================= SERVICES =======================
import * as pendingService from './services/pending/pending.service.js';
import { loadCachesUltra } from './services/search/search.cache.js';

const app = express();
const port = process.env.PORT || 3001;

// ======================= CORS AGGIORNATO E PERMISSIVO =======================
const isAllowedOrigin = (origin, callback) => {
  // 1. Permetti sempre richieste senza Origin (App Mobile, Postman, ecc.)
  if (!origin) return callback(null, true);

  // 2. Permetti domini specifici
  const allowed = ['http://localhost:3000', 'https://turentumi.vercel.app'];
  if (allowed.includes(origin) || origin.endsWith('.vercel.app')) {
    return callback(null, true);
  }

  // 3. Blocca tutto il resto
  console.error(`⚠️ [CORS] Bloccata origine non autorizzata: ${origin}`);
  callback(new Error('CORS non consentito'));
};

app.use(cors({ origin: isAllowedOrigin, credentials: true }));
app.use(cookieParser());
app.use(express.json());

// Log di debug
app.use((req, res, next) => {
  console.log(`📡 [REQ] ${req.method} ${req.url} - Origin: ${req.headers.origin}`);
  next();
});

// ======================= MIDDLEWARE & ROUTES =======================
app.use('/webhook-stripe', express.raw({ type: 'application/json' }), stripeWebhookRouter);
app.use('/api/auth', authRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/booking', bookingRouter);
app.use('/api/booking', bookingClienteRouter);
app.use('/api/disponibilita', disponibilitaRouter);
app.use('/api/veicolo', veicoloRouter);
app.use('/api/corse', corseRouter);
app.use('/api/pending', pendingRouter);
app.use('/api/prenotazioni', prenotazioniRouter);
app.use('/api/pagamenti', pagamentiAutistaRouter);
app.use('/api/tariffe', tariffeRouter);
app.use('/api/distanza', distanzaRouter);
app.use('/api/admin', adminRouter);
app.use('/api/chat', chatRouter);
app.use('/api/search', searchRouter);
app.use('/api/autista/profilo', autistaProfiloRouter);
app.use('/api/autista', autistaStatusRouter);
app.use('/api/autista/documenti', documentiAutistaRouter);
app.use('/api/documenti', documentiVeicoloRouter);
app.use('/api/flows', flowsRouter);

app.get('/', (_, res) => res.json({ status: 'OK', service: 'TURENTU API' }));

// ======================= SERVER INIT =======================
const server = http.createServer(app);

const io = new Server(server, { 
  cors: { 
    origin: isAllowedOrigin, 
    credentials: true 
  },
  pingTimeout: 60000, 
  pingInterval: 25000,
  transports: ['polling', 'websocket'],
  path: "/socket.io/"
});

const startServer = async () => {
  try {
    console.log('🔄 [INIT] Inizializzazione sistema...');

    if (redisClient && !redisClient.isOpen) await redisClient.connect();
    
    const pubClient = redisClient.duplicate();
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    
    io.adapter(createAdapter(pubClient, subClient));
    setupSocket(io);

    flowRegistry.register(onboardingFlow);
    await loadCachesUltra().catch(e => console.error('⚠️ [CACHE] Errore cache:', e.message));
    await pendingService.cleanupExpired().catch(e => console.error('⚠️ [CLEANUP] Errore cleanup:', e.message));

    server.listen(port, '0.0.0.0', () => {
      console.log(`🚀 [SERVER] In ascolto su porta ${port}`);
    });
  } catch (err) {
    console.error('💥 [CRITICAL] Errore critico durante l\'avvio:', err);
    process.exit(1);
  }
};

startServer();

export { io, server };