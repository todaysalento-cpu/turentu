import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch'; // per geocoding (Node <18)
import * as searchService from './services/search/searchUltra.service.js';
import * as pendingService from './services/pending/pending.service.js';
import * as pendingWrapper from './services/pending/pending-prenotazione-pagamento.service.js';
import * as corsaService from './services/corsa/corsa.service.js';
import * as prenotazioneService from './services/prenotazione/prenotazione.service.js';
import * as pagamentoService from './services/pagamento/pagamento.service.js';
import * as veicoloService from './services/veicolo/veicolo.service.js';
// import * as stripeWebhook from './routes/stripe.webhook.js'; // se lo usi

const app = express();

// ---------------------------
// CORS
// ---------------------------
app.use(cors({
  origin: "http://localhost:3000",
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));

// ---------------------------
// STRIPE WEBHOOK (raw body, se usi stripe)
// Deve stare PRIMA di express.json()
// ---------------------------
// app.use('/stripe', stripeWebhook.router);

// ---------------------------
// JSON parser
// ---------------------------
app.use(express.json());

// ---------------------------
// GEOCODING REAL-TIME
// ---------------------------
app.get('/geocode', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: "Indirizzo mancante" });

  try {
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`,
      { headers: { "User-Agent": "TURENTU_APP/1.0" } }
    );
    const data = await geoRes.json();

    if (!data || data.length === 0) {
      return res.status(404).json({ error: "Indirizzo non trovato" });
    }

    res.json({
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
    });
  } catch (err) {
    console.error("Errore geocoding:", err);
    res.status(500).json({ error: "Geocoding fallito" });
  }
});

// ---------------------------
// ENDPOINTS BUSINESS
// ---------------------------

// 1️⃣ Ricerca slot liberi
app.post('/search', async (req, res) => {
  try {
    const slots = await searchService.cercaSlotUltra(req.body);
    res.json(slots);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2️⃣ Creazione pending
app.post('/pending', async (req, res) => {
  try {
    const pending = await pendingService.createPendingFromSlot(req.body);
    res.json(pending);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3️⃣ Prenotazione + pagamento atomico
app.post('/pending/:id/process', async (req, res) => {
  try {
    const result = await pendingWrapper.processPendingWithPayment(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 4️⃣ Prenotazione manuale
app.post('/prenotazione', async (req, res) => {
  try {
    const pren = await prenotazioneService.prenotaCorsa(
      req.body.corsa,
      req.body.clienteId,
      req.body.posti_richiesti
    );
    res.json(pren);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 5️⃣ Aggiornamento posizione veicolo
app.post('/veicolo/:id/posizione', async (req, res) => {
  try {
    const pos = await veicoloService.aggiornaPosizioneVeicolo(
      parseInt(req.params.id),
      req.body.coord
    );
    res.json(pos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------
// SCHEDULER
// ---------------------------

// Pulizia pending scaduti ogni 60s
setInterval(async () => {
  try {
    await pendingService.cleanupExpiredPending();
    console.log('Pending scaduti rimossi');
  } catch (err) {
    console.error('Errore cleanup pending:', err);
  }
}, 60_000);

// Aggiornamento cache veicoli ogni 5min
setInterval(async () => {
  try {
    if (searchService.loadCachesUltra) {
      await searchService.loadCachesUltra();
      console.log('Cache veicoli e corse aggiornata');
    }
  } catch (err) {
    console.error('Errore aggiornamento cache:', err);
  }
}, 300_000);

// ---------------------------
// AVVIO SERVER + caricamento cache iniziale
// ---------------------------
const PORT = process.env.PORT || 3001;

(async () => {
  try {
    if (searchService.loadCachesUltra) {
      await searchService.loadCachesUltra();
      console.log('✅ Cache iniziale caricata');
    }
  } catch (err) {
    console.error('Errore caricamento cache iniziale:', err);
  }

  app.listen(PORT, () => {
    console.log(`🚀 Server avviato su http://localhost:${PORT}`);
  });
})();
