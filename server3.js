// ======================= server.js =======================
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import http from 'http';
import { Server } from 'socket.io';
import fetch from 'node-fetch';
import { pool } from './db/db.js';
import * as pendingService from './services/pending/pending.service.js';
import * as veicoloService from './services/veicolo/veicolo.service.js';
import { loadCachesUltra, getCorseCache } from './services/search/search.cache.js';

// Formatter
import { formatResults } from './services/search/formatter/search.formatter.js';
import { TOP_RESULTS } from './services/search/search.cache.js';

// Routers
import bookingRouter from './routes/booking.routes.js';
import { bookingClienteRouter } from './routes/booking.cliente.routes.js'; // ✅ import nuovo router
import { router as stripeWebhookRouter } from './routes/stripe-webhook.js';
import { router as authRouter } from './routes/auth.routes.js';
import { disponibilitaRouter } from './routes/disponibilita.routes.js';
import { veicoloRouter } from './routes/veicolo.routes.js';
import { corseRouter } from './routes/corse.routes.js';
import { pendingRouter } from './routes/pending.routes.js';
import { tariffeRouter } from './routes/tariffe.routes.js';
import distanzaRouter from './routes/distanza.route.js';

import { authMiddleware } from './middleware/auth.js';

const app = express();
const PORT = process.env.PORT || 3001;

// --------------------------- MIDDLEWARE -----------------------
app.use(cors({ 
  origin: 'http://localhost:3000', 
  credentials: true
}));
app.use(cookieParser());
app.use(express.json());

// Stripe webhook deve essere PRIMA di express.json() se riceve raw body
app.use('/webhook-stripe', stripeWebhookRouter);

// --------------------------- ROUTER ---------------------------
app.use('/auth', authRouter);
app.use('/booking', bookingRouter);

// ✅ nuova route per prenotazioni + pending del cliente
app.use('/booking', bookingClienteRouter);

app.use('/disponibilita', disponibilitaRouter);
app.use('/veicolo', veicoloRouter);
app.use('/corse', corseRouter);
app.use('/pending', pendingRouter);
app.use('/tariffe', tariffeRouter);
app.use('/distanza', distanzaRouter);

// --------------------------- SOCKET.IO ------------------------
const serverHttp = http.createServer(app);
export const io = new Server(serverHttp, {
  cors: { 
    origin: 'http://localhost:3000', 
    methods: ['GET', 'POST'],
    credentials: true
  }
});

io.on('connection', (socket) => {
  console.log('🟢 Nuovo client connesso:', socket.id);

  socket.on('join_autista', (autistaId) => {
    const roomName = `autista_${autistaId}`;
    socket.join(roomName);
    console.log(`🔑 Socket ${socket.id} unito alla stanza ${roomName}`);
  });

  socket.on('leave_autista', (autistaId) => {
    const roomName = `autista_${autistaId}`;
    socket.leave(roomName);
    console.log(`🔑 Socket ${socket.id} lasciato la stanza ${roomName}`);
  });

  socket.on('disconnect', () => console.log('🔴 Client disconnesso:', socket.id));
});

// --------------------------- HEALTH CHECK -------------------
app.get('/', (_, res) => res.json({ status: 'OK', service: 'TURENTU API' }));

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