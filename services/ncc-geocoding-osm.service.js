import { analizzaIndirizzoNcc } from './ncc-normalizzazione-indirizzi.service.js';
import { normalizzaLocalita } from './ncc-locality-resolver.service.js';

const CACHE_MAX = 2048;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map();

function dedicatedEndpoint(value) {
  if (!value) return null;
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.hostname.replace(/\.$/, '') === 'nominatim.openstreetmap.org' ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('NCC_OSM_SEARCH_URL deve indicare un servizio dedicato, senza credenziali nell’URL.');
  }
  return url;
}

function validCoordinate(raw, limit) {
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

function streetKey(value) {
  return normalizzaLocalita(value).replace(/^p zza /, 'piazza ').replace(/^v le /, 'viale ');
}

export function creaGeocoderOsmNcc({
  endpoint = process.env.NCC_OSM_SEARCH_URL,
  token = process.env.NCC_OSM_API_TOKEN,
  fetchFn = fetch,
  guard
} = {}) {
  const urlBase = dedicatedEndpoint(endpoint);
  const stats = { richieste: 0, riutilizzi: 0, validati: 0, errori: 0 };
  const maxRequests = 100;

  async function validaPunto(indirizzo, comuneAtteso) {
    if (!urlBase) return null;
    guard.verifica();
    const analisi = analizzaIndirizzoNcc(indirizzo);
    const comune = comuneAtteso || analisi.comune;
    if (!comune || !analisi.civico || analisi.ambiguo) return null;
    const strada = streetKey(analisi.indirizzo.slice(0, -analisi.civico.length).replace(/[\s,]+$/, ''));
    const civico = normalizzaLocalita(analisi.civico);
    const municipio = normalizzaLocalita(comune);
    if (!strada || !civico || !municipio) return null;

    const cacheKey = JSON.stringify([urlBase.href, municipio, strada, civico]);
    const hit = cache.get(cacheKey);
    if (hit?.expires > Date.now()) {
      stats.riutilizzi++;
      return { ...hit.result, originale: indirizzo };
    }
    if (stats.richieste >= maxRequests) return null;

    const url = new URL(urlBase);
    url.search = new URLSearchParams({
      street: analisi.indirizzo,
      city: comune,
      state: 'Puglia',
      countrycodes: 'it',
      format: 'jsonv2',
      addressdetails: '1',
      'accept-language': 'it',
      limit: '5'
    });
    stats.richieste++;
    try {
      const candidates = await guard.attendi(async () => {
        const timeout = AbortSignal.timeout(3500);
        const response = await fetchFn(url, {
          signal: guard.signal ? AbortSignal.any([guard.signal, timeout]) : timeout,
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Turentu NCC geocoding',
            ...(token ? { Authorization: 'Bearer ' + token } : {})
          }
        });
        if (!response.ok) throw new Error('NCC_OSM_RISPOSTA_NON_VALIDA');
        return response.json();
      });
      guard.verifica();
      if (!Array.isArray(candidates)) throw new Error('NCC_OSM_FORMATO_NON_VALIDO');
      const exact = new Map();
      for (const candidate of candidates) {
        const address = candidate?.address;
        const city = address?.city || address?.town || address?.village || address?.municipality;
        const way = address?.road || address?.pedestrian || address?.residential;
        const lat = validCoordinate(candidate?.lat, 90);
        const lon = validCoordinate(candidate?.lon, 180);
        if (address?.country_code === 'it' && ['puglia', 'apulia'].includes(normalizzaLocalita(address.state)) &&
            normalizzaLocalita(city) === municipio && streetKey(way) === strada &&
            normalizzaLocalita(address.house_number) === civico &&
            lat !== null && lon !== null && lat >= 39.7 && lat <= 42.3 && lon >= 14.5 && lon <= 18.7) {
          exact.set(lat.toFixed(5) + ':' + lon.toFixed(5), { lat, lon });
        }
      }
      if (exact.size !== 1) return null;
      const [point] = exact.values();
      const result = {
        stato: 'VALIDATO_AUTO',
        valido: true,
        fonte: 'OPENSTREETMAP',
        comuneAtteso: comune,
        normalizzato: analisi.normalizzato,
        ...point
      };
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, result });
      stats.validati++;
      return { ...result, originale: indirizzo };
    } catch {
      guard.verifica();
      stats.errori++;
      return null;
    }
  }

  return { validaPunto, diagnostica: () => ({ attivo: Boolean(urlBase), ...stats }) };
}
