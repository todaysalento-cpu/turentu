// utils/maps.util.js
import fetch from 'node-fetch';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ======== DISTANZA & DURATA ========
const mapsCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 ora

function makeCacheKey(origine, destinazione) {
  const oLat = origine.lat?.toFixed(5) ?? '0';
  const oLon = origine.lon?.toFixed(5) ?? '0';
  const dLat = destinazione.lat?.toFixed(5) ?? '0';
  const dLon = destinazione.lon?.toFixed(5) ?? '0';
  return `${oLat}:${oLon}|${dLat}:${dLon}`;
}

/**
 * Restituisce durata in ms e distanza in km tra due coordinate
 * @param {Object} origine {lat, lon}
 * @param {Object} destinazione {lat, lon}
 */
export async function getDurataDistanza(origine, destinazione) {
  if (!GOOGLE_MAPS_API_KEY) throw new Error('Chiave API di Google Maps non definita in GOOGLE_MAPS_API_KEY');

  if (!origine || !destinazione) {
    console.warn('getDurataDistanza: coordinate mancanti');
    return { durataMs: 0, distanzaKm: 0 };
  }

  const key = makeCacheKey(origine, destinazione);
  const cached = mapsCache.get(key);

  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    console.log('🧠 Maps cache HIT');
    return { durataMs: cached.durataMs, distanzaKm: cached.distanzaKm };
  }

  console.log('🌍 Maps API CALL');
  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${origine.lat},${origine.lon}&destinations=${destinazione.lat},${destinazione.lon}&key=${GOOGLE_MAPS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') throw new Error(`Errore Google Maps API: ${data.status}`);

    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== 'OK') {
      console.warn(`Errore distanza tra origine e destinazione: ${element?.status ?? 'UNKNOWN'}`);
      return { durataMs: 0, distanzaKm: 0 };
    }

    const durataMs = (element.duration?.value ?? 0) * 1000;
    const distanzaKm = (element.distance?.value ?? 0) / 1000;

    mapsCache.set(key, { durataMs, distanzaKm, timestamp: Date.now() });

    return { durataMs, distanzaKm };
  } catch (err) {
    console.error('getDurataDistanza ERROR:', err);
    return { durataMs: 0, distanzaKm: 0 };
  }
}

// ======== REVERSE GEOCODE ========
const reverseCache = new Map();
const REVERSE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

/**
 * Restituisce località da coordinate in modo sicuro
 * @param {Object} coord {lat, lon}
 */
export async function getLocalitaSafe(coord) {
  if (!coord?.lat || !coord?.lon) return 'Località sconosciuta';
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('Google Maps API key non definita, uso fallback località sconosciuta');
    return 'Località sconosciuta';
  }

  const key = `${coord.lat.toFixed(5)},${coord.lon.toFixed(5)}`;
  const cached = reverseCache.get(key);

  if (cached && (Date.now() - cached.timestamp < REVERSE_CACHE_TTL)) {
    return cached.data.indirizzo;
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${coord.lat},${coord.lon}&key=${GOOGLE_MAPS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK' || !data.results?.length) {
      return 'Località sconosciuta';
    }

    const result = data.results[0];
    const components = result.address_components;

    const getComponent = (type) => components.find(c => c.types.includes(type))?.long_name;
    const localita = getComponent('locality')
      || getComponent('administrative_area_level_3')
      || getComponent('administrative_area_level_2')
      || result.formatted_address
      || 'Località sconosciuta';

    const payload = { indirizzo: localita };
    reverseCache.set(key, { data: payload, timestamp: Date.now() });

    return localita;
  } catch (err) {
    console.error('getLocalitaSafe ERROR:', err);
    return 'Località sconosciuta';
  }
}
