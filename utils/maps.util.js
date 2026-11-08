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
export async function getRouteGeometry(origine, destinazione, {
  timeoutMs = 12000, fetchImpl = fetch, apiKey = GOOGLE_MAPS_API_KEY
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || typeof fetchImpl !== 'function')
    throw new Error('Configurazione routing non valida');
  if (!apiKey) throw new Error("API Key mancante");

  const o = normalizeCoord(origine);
  const d = normalizeCoord(destinazione);

  if (!o || !d) throw new Error("Coordinate non valide");

  const url = `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${o.lat},${o.lon}` +
    `&destination=${d.lat},${d.lon}` +
    `&overview=full` + 
    `&key=${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw Object.assign(new Error('Routing HTTP non disponibile'), { code: 'ROUTING_HTTP_ERROR' });
    const data = await res.json();

    // Gestione rigorosa: status != OK indica un problema (es: ZERO_RESULTS, REQUEST_DENIED, OVER_QUERY_LIMIT)
    if (data.status !== "OK") {
      throw Object.assign(new Error('Google API Status: ' + data.status), { code: 'ROUTING_PROVIDER_ERROR' });
    }

    if (!data.routes || data.routes.length === 0) {
      throw new Error("Nessuna rotta trovata nei risultati");
    }

    const route = data.routes[0];
    
    // Validazione finale della polyline
    if (!route.overview_polyline?.points) {
      throw new Error("Polyline assente nella risposta");
    }

    const distanzaMetri = route.legs[0].distance.value;

    return {
      polyline: route.overview_polyline.points,
      distanzaKm: distanzaMetri / 1000, // Coerente in KM per evitare errori di scala
      distanzaMetri: distanzaMetri,     // Disponibile anche in metri se necessario
      distanza: distanzaMetri / 1000,   // Retrocompatibilità per codice esistente che legge .distanza
      durata: route.legs[0].duration.value
    };
  } catch (e) {
    // Fetch errors may contain the URL (and API key): expose only a safe error.
    const timeout = controller.signal.aborted;
    const error = new Error(timeout ? 'Timeout routing stradale' : 'Routing stradale non disponibile');
    error.code = timeout ? 'ROUTING_TIMEOUT' : (e.code || 'ROUTING_PROVIDER_ERROR');
    throw error;
  } finally {
    clearTimeout(timer);
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


// ============================================
// PIXEL — IDENTIFICAZIONE TERRITORIALE
// Reverse geocoding strutturato.
// Non modifica getLocalitaSafe().
// ============================================

const reverseDetailsCache = new Map();

export async function getLocalitaDetails(coord) {
  const c = normalizeCoord(coord);

  if (!c ||
      !Number.isFinite(c.lat) ||
      !Number.isFinite(c.lon) ||
      c.lat < -90 || c.lat > 90 ||
      c.lon < -180 || c.lon > 180 ||
      !GOOGLE_MAPS_API_KEY) {
    return null;
  }

  const key = `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  const cached = reverseDetailsCache.get(key);

  if (cached && Date.now() - cached.timestamp < REVERSE_CACHE_TTL) {
    return cached.value;
  }

  try {
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${c.lat},${c.lon}&key=${GOOGLE_MAPS_API_KEY}&language=it`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Google Geocoding HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== "OK" || !data.results?.length) {
      return null;
    }

    const result = data.results[0];
    const components = result.address_components || [];

    const get = (...types) => {
      for (const type of types) {
        const component = components.find(
          item => Array.isArray(item.types) && item.types.includes(type)
        );

        if (component) return component.long_name;
      }

      return null;
    };

    // La località identifica il centro abitato quando Google lo restituisce.
    // Il comune amministrativo resta separato: una frazione può appartenere
    // a un comune diverso dal nome della località.
    const localita = get(
      "locality",
      "postal_town",
      "administrative_area_level_3",
      "administrative_area_level_2"
    );

    const comune = get(
      "administrative_area_level_3",
      "locality"
    );

    if (!localita || !comune) {
      return null;
    }

    const value = {
      localita,
      comune,
      provincia: get("administrative_area_level_2"),
      regione: get("administrative_area_level_1"),
      place_id: result.place_id ?? null,
      lat: c.lat,
      lon: c.lon,
      formatted_address: result.formatted_address ?? null
    };

    reverseDetailsCache.set(key, {
      value,
      timestamp: Date.now()
    });

    return value;
  } catch (error) {
    console.error(
      "[PIXEL TERRITORIAL] Reverse geocoding:",
      error.message
    );

    return null;
  }
}

// =========================
// PLACES API (NEW) - ricerca transitoria per PIXEL
// Non persistere i dettagli Places senza un diritto di utilizzo appropriato.
// =========================
export async function searchGooglePlaces(textQuery, center, {
  apiKey = process.env.GOOGLE_MAPS_API_KEY,
  fetchImpl = fetch,
  radiusMeters = 3000,
  timeoutMs = 12000,
} = {}) {
  const c = normalizeCoord(center);
  if (typeof textQuery !== 'string' || !textQuery.trim()) throw new Error('textQuery obbligatoria');
  if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon) ||
      c.lat < -90 || c.lat > 90 || c.lon < -180 || c.lon > 180) throw new Error('Coordinate non valide');
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY mancante');
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl non valido');
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 50000) throw new Error('radiusMeters non valido');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('timeoutMs non valido');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus,places.types,places.primaryType',
      },
      body: JSON.stringify({
        textQuery: textQuery.trim(), languageCode: 'it', maxResultCount: 10,
        locationBias: { circle: { center: { latitude: c.lat, longitude: c.lon }, radius: radiusMeters } },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 350);
      throw new Error(`Google Places HTTP ${response.status}: ${detail}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload.places) && payload.places != null) throw new Error('Risposta Places non valida');
    return payload.places ?? [];
  } finally {
    clearTimeout(timer);
  }
}
