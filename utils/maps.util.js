import fetch from "node-fetch";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// =========================
// CACHE
// =========================
const mapsCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const reverseCache = new Map();
const REVERSE_CACHE_TTL = 24 * 60 * 60 * 1000;

function normalizeCoord(c) {
  if (!c) return null;
  return {
    lat: typeof c.lat === 'number' ? c.lat : parseFloat(c.lat),
    lon: typeof (c.lon ?? c.lng) === 'number' ? (c.lon ?? c.lng) : parseFloat(c.lon ?? c.lng),
  };
}

function makeCacheKey(o, d) {
  const oLat = o?.lat?.toFixed(5) ?? "0";
  const oLon = o?.lon?.toFixed(5) ?? "0";
  const dLat = d?.lat?.toFixed(5) ?? "0";
  const dLon = d?.lon?.toFixed(5) ?? "0";
  return `${oLat}:${oLon}|${dLat}:${dLon}`;
}

// =========================
// DIRECTIONS API (ROBUSTA)
// =========================
export async function getRouteGeometry(origine, destinazione) {
  if (!GOOGLE_MAPS_API_KEY) throw new Error("API Key mancante");

  const o = normalizeCoord(origine);
  const d = normalizeCoord(destinazione);

  if (!o || !d) throw new Error("Coordinate non valide");

  const url = `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${o.lat},${o.lon}` +
    `&destination=${d.lat},${d.lon}` +
    `&overview=full` + 
    `&key=${GOOGLE_MAPS_API_KEY}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    // Gestione rigorosa: status != OK indica un problema (es: ZERO_RESULTS, REQUEST_DENIED, OVER_QUERY_LIMIT)
    if (data.status !== "OK") {
      throw new Error(`Google API Status: ${data.status} - ${data.error_message || "Nessun dettaglio"}`);
    }

    if (!data.routes || data.routes.length === 0) {
      throw new Error("Nessuna rotta trovata nei risultati");
    }

    const route = data.routes[0];
    
    // Validazione finale della polyline
    if (!route.overview_polyline?.points) {
      throw new Error("Polyline assente nella risposta");
    }

    return {
      polyline: route.overview_polyline.points,
      distanza: route.legs[0].distance.value,
      durata: route.legs[0].duration.value
    };
  } catch (e) {
    console.error("💥 Errore critico getRouteGeometry:", e.message);
    throw e; // Rilancia l'errore per fermare lo script di migrazione
  }
}

// =========================
// DISTANZA + DURATA
// =========================
export async function getDurataDistanza(origine, destinazione) {
  if (!GOOGLE_MAPS_API_KEY) return { durataMs: 0, distanzaKm: 0 };

  const o = normalizeCoord(origine);
  const d = normalizeCoord(destinazione);
  if (!o || !d) return { durataMs: 0, distanzaKm: 0 };

  const key = makeCacheKey(o, d);
  const cached = mapsCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached;

  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${o.lat},${o.lon}&destinations=${d.lat},${d.lon}&key=${GOOGLE_MAPS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const element = data.rows?.[0]?.elements?.[0];

    if (!element || element.status !== "OK") return { durataMs: 0, distanzaKm: 0 };

    const result = {
      durataMs: (element.duration?.value ?? 0) * 1000,
      distanzaKm: (element.distance?.value ?? 0) / 1000,
      timestamp: Date.now(),
    };

    mapsCache.set(key, result);
    return result;
  } catch (e) {
    console.error("Errore getDurataDistanza:", e.message);
    return { durataMs: 0, distanzaKm: 0 };
  }
}

// =========================
// REVERSE GEOCODING
// =========================
export async function getLocalitaSafe(coord) {
  const c = normalizeCoord(coord);
  if (!c?.lat || !c?.lon || !GOOGLE_MAPS_API_KEY) return "Località sconosciuta";

  const key = `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  const cached = reverseCache.get(key);
  if (cached && Date.now() - cached.timestamp < REVERSE_CACHE_TTL) return cached.value;

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${c.lat},${c.lon}&key=${GOOGLE_MAPS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "OK" || !data.results?.length) return "Località sconosciuta";

    const components = data.results[0].address_components || [];
    const get = (type) => components.find(comp => comp.types.includes(type))?.long_name;

    const localita = get("locality") || get("administrative_area_level_3") || get("administrative_area_level_2") || data.results[0].formatted_address;
    const value = localita.replace(", Italy", "").replace(", Italia", "").trim();

    reverseCache.set(key, { value, timestamp: Date.now() });
    return value;
  } catch (err) {
    return "Località sconosciuta";
  }
}