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
import { popbusRouter } from './routes/popbus.routes.js';
import pixelRouter from './routes/pixel.routes.js';
import { tariffeRouter } from './routes/tariffe.routes.js';
import distanzaRouter from './routes/distanza.route.js';
import { notificationsRouter } from './routes/notification.routes.js';
import chatRouter from './routes/chat.routes.js';
import searchRouter from './routes/search.routes.js';
import diagnosticaTratteRedisRouter from './routes/diagnostica-tratte-redis.routes.js';
import diagnosticaNccInfrastrutturaRouter from './routes/diagnostica-ncc-infrastruttura.routes.js';
import autistaProfiloRouter from './routes/autistaProfilo.routes.js';
import autistaStatusRouter from './routes/autistaStatus.routes.js';
import documentiAutistaRouter from './routes/documentiAutista.routes.js';
import documentiVeicoloRouter from './routes/documentiVeicolo.routes.js';
import prenotazioniRouter from './routes/prenotazioni.routes.js';
import pagamentiAutistaRouter from './routes/pagamenti.autista.routes.js';
import walletRouter from './routes/wallet.routes.js';
import { eventiRouter } from './routes/eventi.routes.js';

// ======================= SERVICES + WORKERS =======================
import * as pendingService from './services/pending/pending.service.js';
import { loadCachesUltra } from './services/search/search.cache.js';
import { startPixelFirstWorker } from './workers/popbus-pixel-first.worker.js'; 

const app = express();
const port = process.env.PORT || 3001;

// ======================= CORS AGGIORNATO E PERMISSIVO =======================
const isAllowedOrigin = (origin, callback) => {
  if (!origin) return callback(null, true);
  const allowed = ['http://localhost:3000', 'https://turentumi.vercel.app', 'https://turentu.onrender.com'];
  if (allowed.includes(origin) || origin.endsWith('.vercel.app') || origin.endsWith('.onrender.com')) {
    return callback(null, true);
  }
  console.error(`⚠️ [CORS] Bloccata origine non autorizzata: ${origin}`);
  callback(new Error('CORS non consentito'));
};

app.use(cors({ origin: isAllowedOrigin, credentials: true }));
app.use(cookieParser());

// ======================= STRIPE WEBHOOK =======================
// Deve essere registrato prima di express.json(): Stripe richiede il body raw
// originale per verificare la firma del webhook.
app.use('/webhook-stripe', express.raw({ type: 'application/json' }), stripeWebhookRouter);

// ======================= MIDDLEWARE PARSING JSON =======================
app.use(express.json({ limit: '50mb' }));

// GESTIONE ERRORI PARSING JSON: Previene il crash e risponde con JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('❌ Errore parsing JSON:', err.message);
    return res.status(400).json({ error: 'JSON malformato' });
  }
  next();
});

// --- LOG GLOBALE ---
app.use((req, res, next) => {
  console.log(`📡 [REQ] ${req.method} ${req.url} - Origin: ${req.headers.origin}`);
  next();
});

// --- DEBUG MIDDLEWARE: Intercetta richieste veicolo ---
app.use('/api/veicolo', (req, res, next) => {
    console.log(`🔍 [DEBUG_VEICOLO] Accesso al router veicolo: ${req.method} ${req.url}`);
    next();
}, veicoloRouter);

// ======================= ROUTES =======================
app.use('/api/auth', authRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/booking', bookingRouter);
app.use('/api/booking', bookingClienteRouter);
app.use('/api/disponibilita', disponibilitaRouter);
app.use('/api/corse', corseRouter);
app.use('/api/pending', pendingRouter);
app.use('/api/popbus', popbusRouter);
app.use('/api/pixel', pixelRouter);
app.use('/api/prenotazioni', prenotazioniRouter);
app.use('/api/pagamenti', pagamentiAutistaRouter);
app.use('/api/tariffe', tariffeRouter);
app.use('/api/distanza', distanzaRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin', diagnosticaTratteRedisRouter);
app.use('/api/admin', diagnosticaNccInfrastrutturaRouter);
app.use('/api/chat', chatRouter);
app.use('/api/search', searchRouter);
app.use('/api/autista/profilo', autistaProfiloRouter);
app.use('/api/autista', autistaStatusRouter);
app.use('/api/autista/documenti', documentiAutistaRouter);
app.use('/api/documenti', documentiVeicoloRouter);
app.use('/api/flows', flowsRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/eventi', eventiRouter);

app.get('/', (_, res) => res.json({ status: 'OK', service: 'TURENTU API' }));
app.get('/api/config/version', (req, res) => { res.json({ minVersion: "1.0.0" }); });

// ======================= SERVER INIT =======================
const server = http.createServer(app);

const io = new Server(server, { 
  cors: { origin: isAllowedOrigin, credentials: true },
  pingTimeout: 60000, 
  pingInterval: 25000,
  transports: ['polling', 'websocket'],
  path: "/socket.io/"
});

const startServer = async () => {
  server.listen(port, '0.0.0.0', () => {
    console.log(`🚀 [SERVER] In ascolto su porta ${port}`);
  });

  try {
    console.log('🔄 [INIT] Inizializzazione asincrona servizi...');

    if (redisClient && !redisClient.isOpen) await redisClient.connect();
    
    const pubClient = redisClient.duplicate();
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    
    io.adapter(createAdapter(pubClient, subClient));
    setupSocket(io);

    flowRegistry.register(onboardingFlow);
    
    console.log('🔄 [INIT] Caricamento Cache Ultra in corso...');
    await loadCachesUltra(); 
    console.log('✅ [INIT] Cache Ultra caricata.');
    
    pendingService.cleanupExpired().catch(e => console.error('⚠️ [CLEANUP] Errore:', e.message));

    if (process.env.POPBUS_PIXEL_FIRST_ENABLED !== 'false') {
      startPixelFirstWorker();
      console.log('⚙️ [PIXEL FIRST] Scheduler PIXEL-first V2 avviato.');
    } else {
      console.log('⏸️ [PIXEL FIRST] Scheduler PIXEL-first V2 sospeso.');
    }
    
    // ======================= POPBUS RECONCILIATION =======================
    // Disabilitato per default: non avviare riconciliazioni durante i collaudi.
    if (process.env.POPBUS_RECON_WORKER_ENABLED === 'YES') {
      const { startPopbusReconciliationWorker } = await import('./workers/popbus-reconciliation.worker.js');
      startPopbusReconciliationWorker();
      console.log('[POPBUS RECON] Scheduler riconciliazione avviato.');
    } else {
      console.log('[POPBUS RECON] Scheduler riconciliazione disabilitato.');
    }

    // ======================= PIXEL TERRITORIALE =======================
    // Modalità SHADOW: sola diagnostica e audit, nessuna registrazione fermate.
    // Il controllo orario rispetta il cooldown persistente configurato nel DB.
    if (process.env.PIXEL_TERRITORIAL_MODE === 'SHADOW') {
      const {
        parsePixelTerritorialConfig,
        runPixelTerritorialCycle
      } = await import('./services/pixel/pixel-territorial-runner.service.js');

      const territorialConfig = parsePixelTerritorialConfig();
      let territorialRunning = false;

      const executeTerritorialCycle = async () => {
        if (territorialRunning) return;
        territorialRunning = true;
        try {
          const result = await runPixelTerritorialCycle(territorialConfig);
          console.log('[PIXEL TERRITORIALE] ciclo completato', result);
        } catch (error) {
          console.error('[PIXEL TERRITORIALE] errore ciclo:', error);
        } finally {
          territorialRunning = false;
        }
      };

      // Non bloccare l'avvio delle API durante la diagnostica territoriale.
      void executeTerritorialCycle();

      const territorialInterval = setInterval(
        executeTerritorialCycle,
        60 * 60 * 1000
      );
      territorialInterval.unref();

      console.log('⚙️ [PIXEL TERRITORIALE] Scheduler SHADOW avviato.');
    } else {
      console.log('⏸️ [PIXEL TERRITORIALE] Scheduler disabilitato.');
    }

    console.log('✅ [INIT] Sistema pienamente operativo.');
  } catch (err) {
    console.error('💥 [CRITICAL] Errore durante l\'inizializzazione:', err);
    process.exit(1);
  }
};

startServer();

export { io, server };