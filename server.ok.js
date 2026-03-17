// server.js
import express from 'express';
import cors from 'cors';

import * as searchService from './services/search/searchUltra.service.js';
import * as pendingService from './services/pending/pending.service.js';
import * as pendingWrapper from './services/pending/pending-prenotazione-pagamento.service.js';
import * as prenotazioneService from './services/prenotazione/prenotazione.service.js';
import * as veicoloService from './services/veicolo/veicolo.service.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ---------------------------
// MIDDLEWARE
// ---------------------------
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));

app.use(express.json());

// ---------------------------
// HEALTH CHECK
// ---------------------------
app.get('/', (_, res) => {
  res.json({ status: 'OK', service: 'TURENTU API' });
});

// ---------------------------
// GEOCODING (OPENSTREETMAP)
// ---------------------------
app.get('/geocode', async (req, res) => {
  const { address } = req.query;

  if (!address) {
    return res.status(400).json({ error: 'Indirizzo mancante' });
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      address
    )}&format=json&limit=1`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'TURENTU_APP/1.0'
      }
    });

    if (!response.ok) {
      console.error('Geocode HTTP error:', response.status);
      return res.status(500).json({ error: 'Errore geocoding esterno' });
    }

    const data = await response.json();

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Indirizzo non trovato' });
    }

    res.json({
      lat: Number(data[0].lat),
      lon: Number(data[0].lon)
    });
  } catch (err) {
    console.error('❌ Geocoding fallito:', err);
    res.status(500).json({ error: 'Geocoding fallito' });
  }
});

// ---------------------------
// SEARCH
// ---------------------------
app.post('/search', async (req, res) => {
  console.log("🛰️ /search body:", req.body);  // log input
  try {
    const result = await searchService.cercaSlotUltra(req.body);
    console.log("✅ /search result:", result);   // log output
    res.json(result);
  } catch (err) {
    console.error('❌ Search error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ---------------------------
// PENDING
// ---------------------------
app.post('/pending', async (req, res) => {
  try {
    const pending = await pendingService.createPendingFromSlot(req.body);
    res.json(pending);
  } catch (err) {
    console.error('❌ Pending error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/pending/:id/process', async (req, res) => {
  try {
    const result = await pendingWrapper.processPendingWithPayment(
      Number(req.params.id)
    );
    res.json(result);
  } catch (err) {
    console.error('❌ Pending process error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------
// PRENOTAZIONE
// ---------------------------
app.post('/prenotazione', async (req, res) => {
  try {
    const pren = await prenotazioneService.prenotaCorsa(
      req.body.corsa,
      req.body.clienteId,
      req.body.posti_richiesti
    );
    res.json(pren);
  } catch (err) {
    console.error('❌ Prenotazione error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------
// POSIZIONE VEICOLO
// ---------------------------
app.post('/veicolo/:id/posizione', async (req, res) => {
  try {
    const pos = await veicoloService.aggiornaPosizioneVeicolo(
      Number(req.params.id),
      req.body.coord
    );
    res.json(pos);
  } catch (err) {
    console.error('❌ Posizione veicolo error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------
// SCHEDULER
// ---------------------------
setInterval(async () => {
  try {
    await pendingService.cleanupExpiredPending();
    console.log('🧹 Pending scaduti rimossi');
  } catch (err) {
    console.error('❌ Cleanup pending error:', err);
  }
}, 60_000);

setInterval(async () => {
  try {
    await searchService.loadCachesUltra();
    console.log('♻️ Cache aggiornata');
  } catch (err) {
    console.error('❌ Cache update error:', err);
  }
}, 300_000);

// ---------------------------
// START SERVER
// ---------------------------
(async () => {
  try {
    await searchService.loadCachesUltra();
    console.log('✅ Cache iniziale caricata');
  } catch (err) {
    console.error('❌ Cache init error:', err);
  }

  app.listen(PORT, () => {
    console.log(`🚀 Server avviato su http://localhost:${PORT}`);
  });
})();
