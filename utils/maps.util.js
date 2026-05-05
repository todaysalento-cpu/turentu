// utils/maps.util.js
import fetch from "node-fetch";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// =========================
// DISTANZA & DURATA
// =========================
const mapsCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 ora

function normalizeCoord(c) {
  if (!c) return null;

  return {
    lat: c.lat,
    lon: c.lon ?? c.lng, // 🔥 FIX CRITICO (supporta frontend misto)
  };
}

function makeCacheKey(origine, destinazione) {
  const o = normalizeCoord(origine);
  const d = normalizeCoord(destinazione);

  const oLat = o?.lat?.toFixed(5) ?? "0";
  const oLon = o?.lon?.toFixed(5) ?? "0";
  const dLat = d?.lat?.toFixed(5) ?? "0";
  const dLon = d?.lon?.toFixed(5) ?? "0";

  return `${oLat}:${oLon}|${dLat}:${dLon}`;
}

/**
 * Restituisce durata in ms e distanza in km tra due coordinate
 */
export async function getDurataDistanza(origine, destinazione) {
  if (!GOOGLE_MAPS_API_KEY)
    throw new Error("Chiave API di Google Maps non definita");

  const o = normalizeCoord(origine);
  const d = normalizeCoord(destinazione);

  if (!o || !d) {
    console.warn("getDurataDistanza: coordinate mancanti");
    return { durataMs: 0, distanzaKm: 0 };
  }

  const key = makeCacheKey(o, d);
  const cached = mapsCache.get(key);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log("🧠 Maps cache HIT");
    return {
      durataMs: cached.durataMs,
      distanzaKm: cached.distanzaKm,
    };
  }

  console.log("🌍 Maps API CALL");

  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${o.lat},${o.lon}&destinations=${d.lat},${d.lon}&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK")
      throw new Error(`Google Maps error: ${data.status}`);

    const element = data.rows?.[0]?.elements?.[0];

    if (!element || element.status !== "OK") {
      console.warn("Errore distanza:", element?.status);
      return { durataMs: 0, distanzaKm: 0 };
    }

    const durataMs = (element.duration?.value ?? 0) * 1000;
    const distanzaKm = (element.distance?.value ?? 0) / 1000;

    mapsCache.set(key, {
      durataMs,
      distanzaKm,
      timestamp: Date.now(),
    });

    return { durataMs, distanzaKm };
  } catch (err) {
    console.error("getDurataDistanza ERROR:", err);
    return { durataMs: 0, distanzaKm: 0 };
  }
}

// =========================
// REVERSE GEOCODE (FIXED)
// =========================
const reverseCache = new Map();
const REVERSE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

export async function getLocalitaSafe(coord) {
  const c = normalizeCoord(coord);

  if (!c?.lat || !c?.lon) return "Località sconosciuta";
  if (!GOOGLE_MAPS_API_KEY) return "Località sconosciuta";

  const key = `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  const cached = reverseCache.get(key);

  if (cached && Date.now() - cached.timestamp < REVERSE_CACHE_TTL) {
    return cached.data.indirizzo;
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${c.lat},${c.lon}&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK" || !data.results?.length) {
      return "Località sconosciuta";
    }

    const result = data.results[0];

    // 🔥 FIX IMPORTANTE: usa direttamente formatted_address (più affidabile)
    let localita = result.formatted_address || "Località sconosciuta";

    // pulizia UI leggera
    localita = localita.replace(", Italia", "").trim();

    const payload = { indirizzo: localita };

    reverseCache.set(key, {
      data: payload,
      timestamp: Date.now(),
    });

    return localita;
  } catch (err) {
    console.error("getLocalitaSafe ERROR:", err);
    return "Località sconosciuta";
  }
}