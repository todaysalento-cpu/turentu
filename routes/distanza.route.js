
import express from 'express';
import fetch from 'node-fetch';
import {
  getDurataDistanza,
  getLocalitaSafe
} from '../utils/maps.util.js';

const router = express.Router();

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ==========================================
// VALIDAZIONE COORDINATE
// ==========================================

function normalizeCoordinates(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (
    value.lat === undefined ||
    value.lat === null ||
    (value.lon ?? value.lng) === undefined ||
    (value.lon ?? value.lng) === null
  ) {
    return null;
  }

  if (
    String(value.lat).trim() === '' ||
    String(value.lon ?? value.lng).trim() === ''
  ) {
    return null;
  }

  const lat = Number(value.lat);
  const lon = Number(value.lon ?? value.lng);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    (lat === 0 && lon === 0)
  ) {
    return null;
  }

  return { lat, lon };
}

// ==========================================
// GOOGLE GEOCODING
// ==========================================

async function geocodeGoogle(address) {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY mancante');
  }

  const query = String(address || '').trim();

  if (query.length < 3) {
    throw new Error('Indirizzo non valido');
  }

  const params = new URLSearchParams({
    address: query,
    components: 'country:IT',
    language: 'it',
    key: GOOGLE_MAPS_API_KEY
  });

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 12000);

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`,
      { signal: controller.signal }
    );

    if (!response.ok) {
      throw new Error(
        `Google Geocoding HTTP ${response.status}`
      );
    }

    const data = await response.json();

    if (
      data.status === 'ZERO_RESULTS' ||
      !data.results?.length
    ) {
      const error = new Error(
        `Località non trovata: ${query}`
      );
      error.status = 400;
      throw error;
    }

    if (data.status !== 'OK') {
      throw new Error(
        `Google Geocoding: ${data.status}`
      );
    }

    const result = data.results[0];

    if (result.partial_match === true) {
      const error = new Error(
        `Indirizzo ambiguo: ${query}. Specifica meglio la località.`
      );
      error.status = 400;
      throw error;
    }

    const country = result.address_components?.find(
      component => component.types?.includes('country')
    );

    if (country?.short_name !== 'IT') {
      const error = new Error(
        `Località fuori dall'Italia: ${query}`
      );
      error.status = 400;
      throw error;
    }

    const coordinates = normalizeCoordinates({
      lat: result.geometry?.location?.lat,
      lon: result.geometry?.location?.lng
    });

    if (!coordinates) {
      throw new Error(
        'Coordinate Google Geocoding non valide'
      );
    }

    return coordinates;

  } finally {
    clearTimeout(timeout);
  }
}

// ==========================================
// RISOLUZIONE INDIRIZZO O COORDINATE
// ==========================================

async function resolveLocation(value) {
  if (typeof value !== 'string') {
    const error = new Error(
      'Formato località non valido'
    );
    error.status = 400;
    throw error;
  }

  const input = value.trim();

  if (!input) {
    const error = new Error(
      'Località mancante'
    );
    error.status = 400;
    throw error;
  }

  if (input.startsWith('{')) {
    let parsed;

    try {
      parsed = JSON.parse(input);
    } catch {
      const error = new Error(
        'Coordinate JSON non valide'
      );
      error.status = 400;
      throw error;
    }

    const coordinates = normalizeCoordinates(parsed);

    if (!coordinates) {
      const error = new Error(
        'Coordinate geografiche non valide'
      );
      error.status = 400;
      throw error;
    }

    return coordinates;
  }

  return geocodeGoogle(input);
}

// ==========================================
// ENDPOINT GET /api/distanza
// ==========================================

router.get('/', async (req, res) => {
  try {
    const { origine, destinazione } = req.query;

    if (
      typeof origine !== 'string' ||
      typeof destinazione !== 'string' ||
      !origine.trim() ||
      !destinazione.trim()
    ) {
      return res.status(400).json({
        error: 'Origine o destinazione mancanti'
      });
    }

    if (!GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({
        error: 'Servizio Google Maps non configurato'
      });
    }

    // Risoluzione coordinate tramite Google
    // oppure coordinate già verificate dal frontend.

    const [coordO, coordD] = await Promise.all([
      resolveLocation(origine),
      resolveLocation(destinazione)
    ]);

    console.log('[DISTANZA] Coordinate utilizzate', {
      coordO,
      coordD
    });

    // Distanza stradale Google Distance Matrix

    const { distanzaKm, durataMs } =
      await getDurataDistanza(coordO, coordD);

    if (
      !Number.isFinite(distanzaKm) ||
      distanzaKm <= 0 ||
      !Number.isFinite(durataMs) ||
      durataMs <= 0
    ) {
      return res.status(502).json({
        error: 'Distanza stradale non disponibile'
      });
    }

    // Identificazione località tramite Google

    const [localitaO, localitaD] = await Promise.all([
      getLocalitaSafe(coordO),
      getLocalitaSafe(coordD)
    ]);

    console.log('[DISTANZA] Risultato', {
      origine: localitaO,
      destinazione: localitaD,
      distanzaKm,
      durataMs
    });

    return res.json({
      origine: localitaO,
      destinazione: localitaD,
      distanzaKm,
      durataMs
    });

  } catch (err) {
    console.error(
      '[DISTANZA] Errore:',
      err.message
    );

    const status = err.status === 400 ? 400 : 500;

    return res.status(status).json({
      error:
        status === 400
          ? err.message
          : 'Errore calcolo distanza'
    });
  }
});

export default router;
