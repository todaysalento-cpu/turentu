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

// ======================= APP =======================
const app = express();
const port = process.env.PORT || 3001;

// ======================= CORS =======================
const FRONTEND_PROD = ['https://turentumi.vercel.app'];
const FRONTEND_DEV = ['http://localhost:3000'];

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (FRONTEND_DEV.includes(origin)) return true;
  if (FRONTEND_PROD.includes(origin)) return true;
  if (origin.endsWith('.vercel.app')) return true;
  return false;
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    console.warn(`❌ CORS non consentito per origin: ${origin}`);
    return callback(new Error('CORS non consentito'));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

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

// ======================= HEALTH CHECK =======================
app.get('/', (_, res) => res.json({ status: 'OK', service: 'TURENTU API' }));

// ======================= ERROR HANDLERS =======================
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));
app.use((err, req, res, next) => {
  console.error('💥 ERROR:', err.message);
  res.status(err.status || 500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message });
});

// ======================= SERVER INIT =======================
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: isAllowedOrigin, credentials: true } });

setupSocket(io);

const startServer = async () => {
  try {
    console.log('🔄 Inizializzazione sistema...');
    
    // 1. Registrazione Flussi
    flowRegistry.register(onboardingFlow);
    console.log('🟢 Flussi registrati');

    // 2. Connessione Redis e Caricamento Cache
    if (redisClient && !redisClient.isOpen) await redisClient.connect();
    console.log('🟢 Redis pronto');

    await loadCachesUltra();
    console.log('🗃️ Cache caricate');

    // 3. Cleanup Pendings
    const count = await pendingService.cleanupExpired();
    console.log(`🧹 Cleanup pending completato: ${count}`);

    // 4. Avvio Ascolto
    server.listen(port, '0.0.0.0', () => {
      console.log(`🚀 Server in ascolto su porta ${port}`);
    });
  } catch (err) {
    console.error('💥 Errore critico durante l\'avvio:', err);
    process.exit(1);
  }
};

startServer();

export { io, server };