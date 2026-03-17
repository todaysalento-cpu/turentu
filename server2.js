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

// Routers
import bookingRouter from './routes/booking.routes.js';
import { router as stripeWebhookRouter } from './routes/stripe-webhook.js';
import { router as authRouter } from './routes/auth.routes.js';
import { disponibilitaRouter } from './routes/disponibilita.routes.js';
import { veicoloRouter } from './routes/veicolo.routes.js';
import { corseRouter } from './routes/corse.routes.js';
import { pendingRouter } from './routes/pending.routes.js';

import { authMiddleware } from './middleware/auth.js';

const app = express();
const PORT = process.env.PORT || 3001;

// --------------------------- MIDDLEWARE -----------------------
app.use(cors({ 
  origin: 'http://localhost:3000', 
  credentials: true // ✅ importante per i cookie cross-origin
}));
app.use(cookieParser());
app.use(express.json());

// Stripe webhook deve essere PRIMA di express.json() se riceve raw body
app.use('/webhook-stripe', stripeWebhookRouter);

// --------------------------- ROUTER ---------------------------
app.use('/auth', authRouter);
app.use('/booking', bookingRouter);
app.use('/disponibilita', disponibilitaRouter);
app.use('/veicolo', veicoloRouter);
app.use('/corse', corseRouter);
app.use('/pending', pendingRouter);

// --------------------------- SOCKET.IO ------------------------
const serverHttp = http.createServer(app);
export const io = new Server(serverHttp, {
  cors: { 
    origin: 'http://localhost:3000', 
    methods: ['GET', 'POST'],
    credentials: true // ✅ permette i cookie / auth token
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

// --------------------------- TARIFFE --------------------------
app.get('/tariffe/veicolo/:id', authMiddleware, async (req, res) => {
  try {
    const veicoloId = Number(req.params.id);
    const result = await pool.query(
      `SELECT * FROM tariffe WHERE veicolo_id=$1 ORDER BY tipo, id`,
      [veicoloId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Fetch tariffe error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/tariffe', authMiddleware, async (req, res) => {
  try {
    const { veicolo_id, tipo, euro_km, prezzo_passeggero, giorno_settimana, ora_inizio, ora_fine } = req.body;
    const result = await pool.query(
      `INSERT INTO tariffe 
        (veicolo_id, tipo, euro_km, prezzo_passeggero, giorno_settimana, ora_inizio, ora_fine)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [veicolo_id, tipo || 'standard', euro_km || 1, prezzo_passeggero || 0, giorno_settimana, ora_inizio, ora_fine]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Inserimento tariffa error:', err);
    res.status(500).json({ error: err.message });
  }
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

// --------------------------- VEICOLO POSIZIONE -----------------
app.post('/veicolo/:id/posizione', async (req, res) => {
  try {
    const pos = await veicoloService.aggiornaPosizioneVeicolo(Number(req.params.id), req.body.coord);
    res.json(pos);
  } catch (err) {
    console.error('❌ Posizione veicolo error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------- NOTIFICHE -----------------------
app.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    let notifications = { prenotazioni: 0, corse: 0, pagamenti: 0 };

    switch (user.role) {
      case 'cliente':
        notifications.prenotazioni = await pendingService.countPendingByCliente(user.id);
        break;
      case 'autista':
        notifications.corse = await getCorseCache(user.id);
        break;
      case 'admin':
        notifications.pagamenti = await pendingService.countAllPending();
        break;
    }

    res.json(notifications);
  } catch (err) {
    console.error('❌ Notifications error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------- GEOCODING ------------------------
app.get('/api/geocode', async (req, res) => {
  const { place_id } = req.query;
  if (!place_id) return res.status(400).json({ error: 'place_id mancante' });

  if (!process.env.GOOGLE_MAPS_API_KEY) return res.status(500).json({ error: 'Google Maps API key non definita' });

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?place_id=${place_id}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') return res.status(500).json({ error: data.status });

    const result = data.results[0];
    const components = result.address_components;
    const getComponent = (type) => components.find(c => c.types.includes(type))?.long_name;

    const localita = getComponent('locality')
      || getComponent('administrative_area_level_3')
      || getComponent('administrative_area_level_2')
      || result.formatted_address
      || 'Località sconosciuta';

    res.json({
      nome: localita,
      coord: {
        lat: result.geometry.location.lat,
        lon: result.geometry.location.lng
      }
    });
  } catch (err) {
    console.error('❌ Geocode error:', err);
    res.status(500).json({ error: 'Errore geocoding' });
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
