// --- DEBUG FATALE ---
process.on('uncaughtException', (err) => { console.error('--- CRASH FATALE ---', err); process.exit(1); });
process.on('unhandledRejection', (reason, promise) => { console.error('--- REJECTION NON GESTITA ---', reason); process.exit(1); });

import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import http from 'http';
import { Server } from 'socket.io';
import { createAdapter } from "@socket.io/redis-adapter"; // <--- IMPORT AGGIUNTO

// ======================= SOCKET + REDIS =======================
import { setupSocket } from './socket.js';
import { redisClient } from './redis.js';

// ... (tutti gli altri import rimangono identici)
import { flowRegistry } from './core/registry/flowRegistry.js';
import { onboardingFlow } from './core/registry/flows/onboarding.flow.js';
import * as pendingService from './services/pending/pending.service.js';
import { loadCachesUltra } from './services/search/search.cache.js';
import { stripeWebhookRouter, authRouter, notificationsRouter, bookingRouter, bookingClienteRouter, disponibilitaRouter, veicoloRouter, corseRouter, pendingRouter, tariffeRouter, distanzaRouter, chatRouter, searchRouter, autistaProfiloRouter, autistaStatusRouter, documentiAutistaRouter, documentiVeicoloRouter, prenotazioniRouter, pagamentiAutistaRouter, adminRouter, flowsRouter } from './routes/index.js'; // Assumendo che tu abbia un barrel file per le rotte

const app = express();
const port = process.env.PORT || 3001;

// ======================= CORS & MIDDLEWARE =======================
const isAllowedOrigin = (origin) => !origin || ['http://localhost:3000', 'https://turentumi.vercel.app'].includes(origin) || origin.endsWith('.vercel.app');
app.use(cors({ origin: (origin, callback) => isAllowedOrigin(origin) ? callback(null, true) : callback(new Error('CORS non consentito')), credentials: true }));
app.use(express.json());
app.use(cookieParser());

// ======================= SERVER INIT =======================
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: isAllowedOrigin, credentials: true } });

const startServer = async () => {
  try {
    console.log('🔄 Inizializzazione sistema...');

    // 1. Connessione Redis e configurazione Adapter
    if (redisClient && !redisClient.isOpen) await redisClient.connect();
    
    const pubClient = redisClient.duplicate();
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    
    io.adapter(createAdapter(pubClient, subClient));
    console.log('🟢 Redis Adapter per Socket.io configurato');

    // 2. Setup Socket
    setupSocket(io);

    // 3. Registrazione Flussi
    flowRegistry.register(onboardingFlow);
    
    // 4. Caricamento Cache e Cleanup
    await loadCachesUltra().catch(e => console.error('⚠️ Errore cache:', e.message));
    await pendingService.cleanupExpired().catch(e => console.error('⚠️ Errore cleanup:', e.message));

    // 5. Avvio Ascolto
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