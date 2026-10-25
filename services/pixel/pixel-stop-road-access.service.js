// services/pixel/pixel-stop-road-access.service.js
// PIXEL: raggiungibilita' stradale stimata con Google Distance Matrix.
// Non scrive sul DB e non certifica la possibilita' di fermata/carico/scarico.

const ENDPOINT = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const STATI = Object.freeze({
  OK: 'raggiungibile',
  NO: 'non_raggiungibile',
  UNKNOWN: 'non_valutabile',
});

function coord(value) {
  const lat = Number(value?.lat);
  const lon = Number(value?.lon ?? value?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180 ||
      value?.lat == null || (value?.lon == null && value?.lng == null)) return null;
  return { lat, lon };
}

function result(stato, motivo, extra = {}) {
  return { stato, raggiungibile: stato === STATI.OK ? true : stato === STATI.NO ? false : null,
    motivo, distanza_m: null, durata_s: null, ...extra };
}

/**
 * Valuta un percorso in modalita' driving fra due coordinate affidabili.
 * Una rotta valida prova solo la raggiungibilita' stimata della destinazione.
 * Non prova l'esistenza di uno spazio autorizzato per salita/discesa.
 *
 * @param {object} origine {lat,lon} - punto stradale di riferimento
 * @param {object} destinazione {lat,lon} - candidato PIXEL
 * @param {object} options
 * @param {string} [options.apiKey] chiave Google, altrimenti GOOGLE_MAPS_API_KEY
 * @param {Function} [options.fetchImpl] fetch iniettabile per test
 * @param {number} [options.timeoutMs=12000]
 */
export async function checkPixelStopRoadAccess(origine, destinazione, options = {}) {
  const o = coord(origine);
  const d = coord(destinazione);
  if (!o || !d) return result(STATI.UNKNOWN, 'coordinate_non_valide');

  const apiKey = options.apiKey ?? process.env.GOOGLE_MAPS_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return result(STATI.UNKNOWN, 'api_key_assente');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 12000;
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error('PIXEL: configurazione road access non valida');
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set('units', 'metric');
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('origins', `${o.lat},${o.lon}`);
  url.searchParams.set('destinations', `${d.lat},${d.lon}`);
  url.searchParams.set('key', apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), { signal: controller.signal });
    if (!response.ok) return result(STATI.UNKNOWN, 'http_error', { http_status: response.status });
    const data = await response.json();
    if (data?.status !== 'OK') {
      return result(STATI.UNKNOWN, 'google_api_error', { google_status: data?.status ?? 'MISSING' });
    }
    const element = data.rows?.[0]?.elements?.[0];
    if (!element) return result(STATI.UNKNOWN, 'risposta_incompleta');
    if (element.status === 'ZERO_RESULTS') {
      return result(STATI.NO, 'zero_results', { google_status: element.status });
    }
    if (element.status !== 'OK') {
      return result(STATI.UNKNOWN, 'elemento_google_non_valido', { google_status: element.status ?? 'MISSING' });
    }
    const distance = element.distance?.value;
    const duration = element.duration?.value;
    if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(duration) || duration < 0) {
      return result(STATI.UNKNOWN, 'metriche_mancanti');
    }
    return result(STATI.OK, 'percorso_google_valido', {
      distanza_m: distance,
      durata_s: duration,
      google_status: 'OK',
    });
  } catch (error) {
    return result(STATI.UNKNOWN, error?.name === 'AbortError' ? 'timeout' : 'errore_rete');
  } finally {
    clearTimeout(timer);
  }
}

/** Verifica sequenziale: evita raffiche di richieste e facilita la diagnosi. */
export async function checkPixelStopsRoadAccess(origine, candidati, options = {}) {
  if (!Array.isArray(candidati)) throw new Error('PIXEL: candidati non validi');
  const risultati = [];
  for (const candidato of candidati) {
    const esito = await checkPixelStopRoadAccess(origine, candidato, options);
    risultati.push({ place_id: candidato.place_id ?? null, nome: candidato.nome ?? null, ...esito });
  }
  return {
    totale: risultati.length,
    raggiungibili: risultati.filter(x => x.stato === STATI.OK).length,
    non_raggiungibili: risultati.filter(x => x.stato === STATI.NO).length,
    non_valutabili: risultati.filter(x => x.stato === STATI.UNKNOWN).length,
    risultati,
  };
}
