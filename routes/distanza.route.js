import express from 'express';
import NodeGeocoder from 'node-geocoder';
import { getDurataDistanza, getLocalitaSafe } from '../utils/maps.util.js';

const router = express.Router();
const geocoder = NodeGeocoder({ provider: 'openstreetmap' });

router.get('/', async (req, res) => {
  try {
    let { origine, destinazione } = req.query;

    if (!origine || !destinazione) {
      return res.status(400).json({ error: 'Origine o destinazione mancanti' });
    }

    let coordO, coordD;
    try {
      coordO = typeof origine === 'string' && origine.startsWith('{') ? JSON.parse(origine) : null;
      coordD = typeof destinazione === 'string' && destinazione.startsWith('{') ? JSON.parse(destinazione) : null;
    } catch (err) {
      console.warn('Parsing coordinate JSON fallito, useremo geocoding:', err);
    }

    if (!coordO) {
      const geoO = await geocoder.geocode(origine);
      if (!geoO.length) return res.status(400).json({ error: 'Origine non trovata' });
      coordO = { lat: geoO[0].latitude, lon: geoO[0].longitude };
    }

    if (!coordD) {
      const geoD = await geocoder.geocode(destinazione);
      if (!geoD.length) return res.status(400).json({ error: 'Destinazione non trovata' });
      coordD = { lat: geoD[0].latitude, lon: geoD[0].longitude };
    }

    const { distanzaKm, durataMs } = await getDurataDistanza(coordO, coordD);

    const localitaO = await getLocalitaSafe(coordO);
    const localitaD = await getLocalitaSafe(coordD);

    res.json({
      origine: localitaO,
      destinazione: localitaD,
      distanzaKm,
      durataMs
    });

  } catch (err) {
    console.error('❌ /distanza error:', err);
    res.status(500).json({ error: 'Errore calcolo distanza' });
  }
});

export default router;