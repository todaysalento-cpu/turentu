// utils/mapsCache.util.js
import { stimaDurata as mapsStimaDurata } from './maps.util.js';

// Cache in memoria: key = `${latOrig}-${lonOrig}_${latDest}-${lonDest}`
const mapsCache = new Map();

// TTL in millisecondi (es. 1 ora)
const CACHE_TTL = 60 * 60 * 1000;

/**
 * Restituisce durata e distanza tra due coordinate usando Google Maps
 * con cache in memoria e TTL
 * @param {Object} origine {lat, lon}
 * @param {Object} destinazione {lat, lon}
 * @returns {Object} { durataMs, distanzaKm }
 */
export async function getDurataDistanza(origine, destinazione) {
  const key = `${origine.lat},${origine.lon}_${destinazione.lat},${destinazione.lon}`;

  const now = Date.now();

  // Cache HIT valida
  if (mapsCache.has(key)) {
    const entry = mapsCache.get(key);
    if (now - entry.timestamp < CACHE_TTL) {
      console.log('🧠 Maps cache HIT');
      return { durataMs: entry.durataMs, distanzaKm: entry.distanzaKm };
    } else {
      // Cache scaduta
      mapsCache.delete(key);
    }
  }

  // Cache MISS → chiama Google Maps
  console.log('🌍 Maps API CALL');
  const durataMs = await mapsStimaDurata(origine, destinazione);

  // Calcola distanza haversine per avere km
  const distanzaKm = Math.round(
    ((origine.lat && origine.lon && destinazione.lat && destinazione.lon)
      ? haversine(origine, destinazione)
      : 0) * 100
  ) / 100;

  // Salva in cache
  mapsCache.set(key, { durataMs, distanzaKm, timestamp: now });

  return { durataMs, distanzaKm };
}

/**
 * Funzione haversine per calcolare distanza in km
 */
function haversine(coord1, coord2) {
  const R = 6371; // km
  const dLat = deg2rad(coord2.lat - coord1.lat);
  const dLon = deg2rad(coord2.lon - coord1.lon);
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(coord1.lat)) *
    Math.cos(deg2rad(coord2.lat)) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function deg2rad(deg) {
  return deg * (Math.PI/180);
}
