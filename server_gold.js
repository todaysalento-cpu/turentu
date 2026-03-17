// server.js
import express from 'express';
import cors from 'cors';
import 'dotenv/config';

import { formatResults } from './services/search/formatter/search.formatter.js';
import { 
  loadCachesUltra, 
  getVeicoliCache, 
  getDisponibilitaCache, 
  getCorseCache 
} from './services/search/search.cache.js';

import * as pendingService from './services/pending/pending.service.js';
import * as pendingWrapper from './services/pending/pending-prenotazione-pagamento.service.js';
import * as prenotazioneService from './services/prenotazione/prenotazione.service.js';
import * as veicoloService from './services/veicolo/veicolo.service.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ---------------------------
// MIDDLEWARE
// ---------------------------
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.json());

// ---------------------------
// HEALTH CHECK
// ---------------------------
app.get('/', (_, res) => {
  res.json({ status: 'OK', service: 'TURENTU API' });
});

// ---------------------------
// GEOCODING
// ---------------------------
app.get('/geocode', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Indirizzo mancante' });

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
    const response = await fetch(url, { headers: { 'User-Agent': 'TURENTU_APP/1.0' } });
    if (!response.ok) return res.status(500).json({ error: 'Errore geocoding esterno' });

    const data = await response.json();
    if (!data || !data.length) return res.status(404).json({ error: 'Indirizzo non trovato' });

    res.json({ lat: Number(data[0].lat), lon: Number(data[0].lon) });
  } catch (err) {
    console.error('❌ Geocoding fallito:', err);
    res.status(500).json({ error: 'Geocoding fallito' });
  }
});

// ---------------------------
// REVERSE GEOCODING
// ---------------------------
app.get('/reverse-geocode', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Latitudine e longitudine mancanti' });

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=json&addressdetails=1&lang=it`;
    const response = await fetch(url, { headers: { 'User-Agent': 'TURENTU_APP/1.0' } });
    if (!response.ok) return res.status(500).json({ error: 'Errore geocoding inverso esterno' });

    const data = await response.json();
    if (!data || !data.address) return res.status(404).json({ error: 'Indirizzo non trovato per le coordinate date' });

    res.json({ indirizzo: data.display_name, lat: data.lat, lon: data.lon });
  } catch (err) {
    console.error('❌ Reverse geocoding fallito:', err);
    res.status(500).json({ error: 'Geocoding inverso fallito' });
  }
});

// ---------------------------
// SEARCH
// ---------------------------
app.post('/search', async (req, res) => {
  console.log("🛰️ /search body:", req.body);
  try {
    const form = req.body;

    // Assicura che coordDest esista
    if (!form.coordDest) form.coordDest = { lat: 0, lon: 0 };

    // Usa la funzione dell'orchestratore per creare slot/corse
    const { cercaSlotUltra } = await import('./services/search/search.service.js');
    const risultati = await cercaSlotUltra(form);

    console.log("✅ /search result:", risultati);
    res.json(risultati);
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
    const result = await pendingWrapper.processPendingWithPayment(Number(req.params.id));
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
    const pos = await veicoloService.aggiornaPosizioneVeicolo(Number(req.params.id), req.body.coord);
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

// ---------------------------
// START SERVER
// ---------------------------
(async () => {
  try {
    await loadCachesUltra();
    console.log('✅ Cache iniziale caricata');
  } catch (err) {
    console.error('❌ Cache init error:', err);
  }

  app.listen(PORT, () => {
    console.log(`🚀 Server avviato su http://localhost:${PORT}`);
  });
})();
