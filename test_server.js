import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json());

// Dati dummy
const veicoliCache = [
  { id: 1, lat: 41.89, lon: 12.495, posti_totali: 4, euro_km: 1 },
  { id: 2, lat: 41.891, lon: 12.496, posti_totali: 3, euro_km: 1 },
];

const corseCache = [
  {
    id: 101,
    veicolo_id: 1,
    start_datetime: new Date().toISOString(),
    arrivo_datetime: new Date(new Date().getTime() + 30 * 60 * 1000).toISOString(),
    posti_disponibili: 2,
    stato: 'prenotabile',
    origine_lat: 41.89,
    origine_lon: 12.495,
    dest_lat: 41.892,
    dest_lon: 12.496,
  },
];

// Dummy calcolo prezzo (sincrono)
const calcolaPrezzo = ({ km }, euro_km) => km * euro_km;

// Endpoint search
app.post('/search', (req, res) => {
  const { coord, posti_richiesti, km } = req.body;

  // Slot liberi
  const slots = veicoliCache
    .filter((v) => v.posti_totali >= posti_richiesti)
    .map((v) => ({
      veicolo_id: v.id,
      coord: { lat: v.lat, lon: v.lon },
      corseCompatibili: [],
      slot_libero: true,
      distanzaKm: 0,
      prezzo: calcolaPrezzo({ km }, v.euro_km), // OK senza await
      stato: 'libero',
    }));

  // Corse compatibili
  const corse = corseCache
    .filter((c) => c.posti_disponibili >= posti_richiesti)
    .map((c) => ({
      veicolo_id: c.veicolo_id,
      coord: { lat: c.origine_lat, lon: c.origine_lon },
      corseCompatibili: [
        { id: c.id, origine: c.start_datetime, destinazione: c.arrivo_datetime },
      ],
      slot_libero: false,
      distanzaKm: 0,
      prezzo: calcolaPrezzo({ km }, 1),
      stato: c.stato,
    }));

  res.json([...slots, ...corse]);
});

app.listen(3002, () => console.log('Server test avviato su http://localhost:3002'));
